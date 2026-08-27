//! Stable loopback port selection and conflict handling.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const MIN_EDITOR_PORT: u16 = 1024;

/// macOS hands out 49152-65535 for ephemeral client sockets. A port taken from
/// that range by binding zero is a port the OS is free to give to any other
/// program the moment DevHub is not holding it, which is what turns a stable
/// origin into a recurring conflict. The origin is drawn from below that floor
/// instead, where nothing is assigned without asking for it by number.
const EPHEMERAL_PORT_FLOOR: u16 = 49_152;
const STABLE_PORT_FIRST: u16 = 39_152;
const STABLE_PORT_LAST: u16 = 39_651;
const _: () = assert!(STABLE_PORT_LAST < EPHEMERAL_PORT_FLOOR);

pub trait PortAllocator: Send + Sync {
    fn choose(&self) -> EditorResult<u16>;
    fn is_available(&self, port: u16) -> bool;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemPortAllocator;

impl PortAllocator for SystemPortAllocator {
    fn choose(&self) -> EditorResult<u16> {
        for port in STABLE_PORT_FIRST..=STABLE_PORT_LAST {
            if reusable_origin_bind(port).is_ok() {
                return Ok(port);
            }
        }
        // Five hundred occupied candidates is not a machine where holding out
        // for a durable origin helps anyone. Fall back to whatever the OS will
        // give, and let the conflict path move the origin again if it has to.
        TcpListener::bind((super::paths::LOOPBACK_HOST, 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .map_err(EditorError::from)
    }

    fn is_available(&self, port: u16) -> bool {
        reusable_origin_bind(port).is_ok()
    }
}

fn reusable_origin_bind(port: u16) -> std::io::Result<socket2::Socket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )?;
    // VS Code restarts the same loopback origin after accepted connections
    // close. SO_REUSEADDR distinguishes reusable TIME_WAIT from an active
    // listener; SO_REUSEPORT is deliberately not enabled.
    socket.set_reuse_address(true)?;
    let address = std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, port);
    socket.bind(&socket2::SockAddr::from(address))?;
    Ok(socket)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StablePort {
    port: u16,
    persisted: bool,
}

impl StablePort {
    pub fn load_or_select(
        path: impl AsRef<Path>,
        allocator: &dyn PortAllocator,
    ) -> EditorResult<Self> {
        let path = path.as_ref();
        reject_symlink(path)?;
        match fs::symlink_metadata(path) {
            Ok(_) => {
                harden_file(path)?;
                let value = fs::read_to_string(path)
                    .map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
                let port = parse_port(&value)?;
                Ok(Self { port, persisted: true })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let port = allocator.choose()?;
                validate_port(port)?;
                write_port(path, port)?;
                Ok(Self { port, persisted: false })
            }
            Err(_) => Err(EditorError::new(EditorErrorCode::InvalidPort)),
        }
    }

    pub const fn port(self) -> u16 {
        self.port
    }

    #[cfg(test)]
    pub const fn persisted(self) -> bool {
        self.persisted
    }

    /// Whether the persisted origin can be listened on right now.
    pub fn is_free(self, allocator: &dyn PortAllocator) -> bool {
        allocator.is_available(self.port)
    }

    /// Give up this origin and persist a new one.
    ///
    /// The last resort, and it is not free: WebKit partitions storage by
    /// origin, so the Workbench that comes back on a moved port has none of
    /// the layout or open editors the old one accumulated. It is still the
    /// better outcome than an Editor that cannot start at all for as long as
    /// some other program holds the port.
    pub fn migrate(
        self,
        path: impl AsRef<Path>,
        allocator: &dyn PortAllocator,
    ) -> EditorResult<Self> {
        let port = allocator.choose()?;
        validate_port(port)?;
        if port == self.port {
            return Err(EditorError::new(EditorErrorCode::PortConflict));
        }
        let path = path.as_ref();
        reject_symlink(path)?;
        let _ = fs::remove_file(path);
        write_port(path, port)?;
        Ok(Self { port, persisted: true })
    }

    /// A persisted port is an origin identity. Occupancy is a visible
    /// conflict, never a reason to select a replacement port.
    pub fn ensure_available(self, allocator: &dyn PortAllocator) -> EditorResult<()> {
        if allocator.is_available(self.port) {
            Ok(())
        } else {
            Err(EditorError::new(EditorErrorCode::PortConflict).with_detail(format!(
                "127.0.0.1:{} is already in use by another process. DevHub \
                 stops a leftover editor server of its own automatically, and \
                 moves the origin when it is starting fresh, so this is a port \
                 held by something else while the editor is already running \
                 against it. Quit whatever holds it and retry.",
                self.port
            )))
        }
    }
}

fn parse_port(value: &str) -> EditorResult<u16> {
    let value = value.strip_suffix('\n').unwrap_or(value);
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    }
    let port = value.parse::<u16>().map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
    validate_port(port)?;
    Ok(port)
}

fn validate_port(port: u16) -> EditorResult<()> {
    if port < MIN_EDITOR_PORT {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> EditorResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EditorError::new(EditorErrorCode::PermissionDenied))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(EditorError::new(EditorErrorCode::InvalidPort)),
    }
}

fn write_port(path: &Path, port: u16) -> EditorResult<()> {
    let parent = path.parent().ok_or_else(|| EditorError::new(EditorErrorCode::InvalidPort))?;
    secure_parent(path)?;
    fs::create_dir_all(parent).map_err(EditorError::from)?;
    secure_parent(path)?;
    let temporary = temporary_path(path)?;
    reject_symlink(&temporary)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(EditorError::from)?;
    if let Err(error) = writeln!(file, "{port}").and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    harden_file(path)
}

fn temporary_path(path: &Path) -> EditorResult<PathBuf> {
    let mut nonce = [0_u8; 8];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut nonce))
        .map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
    let suffix = nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    Ok(PathBuf::from(format!("{}.{}.tmp", path.display(), suffix)))
}

fn harden_file(path: &Path) -> EditorResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(EditorError::from)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
    }
    if metadata.len() > 16 {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != nix::unistd::geteuid().as_raw() {
            return Err(EditorError::new(EditorErrorCode::PermissionDenied));
        }
        if metadata.permissions().mode() & 0o777 != 0o600 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(EditorError::from)?;
        }
    }
    Ok(())
}

fn secure_parent(path: &Path) -> EditorResult<()> {
    let Some(parent) = path.parent() else {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    };
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(EditorError::new(EditorErrorCode::PermissionDenied));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct FakeAllocator {
        selected: u16,
        available: bool,
    }

    impl PortAllocator for FakeAllocator {
        fn choose(&self) -> EditorResult<u16> {
            Ok(self.selected)
        }

        fn is_available(&self, _port: u16) -> bool {
            self.available
        }
    }

    fn temp_path() -> PathBuf {
        let root = fs::canonicalize(std::env::temp_dir()).expect("canonical temp directory").join(
            format!(
                "devhub-editor-port-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        );
        fs::create_dir_all(&root).expect("temp root");
        root.join("port")
    }

    #[test]
    fn first_selection_is_persisted_and_relaunch_keeps_origin_port() {
        let path = temp_path();
        let allocator = FakeAllocator { selected: 54945, available: true };
        let first = StablePort::load_or_select(&path, &allocator).expect("first port");
        assert_eq!(first.port(), 54945);
        assert!(!first.persisted());
        let relaunch =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54946, available: true })
                .expect("relaunch port");
        assert_eq!(relaunch.port(), 54945);
        assert!(relaunch.persisted());
    }

    #[test]
    fn occupied_stable_port_is_visible_conflict_without_reselection() {
        let path = temp_path();
        let port =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54945, available: true })
                .expect("port");
        let error = port
            .ensure_available(&FakeAllocator { selected: 54946, available: false })
            .expect_err("occupied port");
        assert_eq!(error.code(), EditorErrorCode::PortConflict);
        assert_eq!(fs::read_to_string(path).expect("stable file").trim(), "54945");
    }

    #[test]
    fn a_migrated_origin_replaces_the_persisted_one() {
        // Giving up the origin costs the Workbench its per-origin storage, so
        // it is the last resort — but an Editor that cannot start at all for as
        // long as a stranger holds the port is the worse outcome.
        let path = temp_path();
        let held =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54945, available: true })
                .expect("port");
        assert!(!held.is_free(&FakeAllocator { selected: 39152, available: false }));
        let moved = held
            .migrate(&path, &FakeAllocator { selected: 39152, available: true })
            .expect("migrated");
        assert_eq!(moved.port(), 39152);
        assert_eq!(fs::read_to_string(&path).expect("stable file").trim(), "39152");
        // The moved origin is the one a relaunch reads back.
        let relaunch =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 40000, available: true })
                .expect("relaunch");
        assert_eq!(relaunch.port(), 39152);
    }

    #[test]
    fn migration_refuses_to_hand_back_the_port_it_is_leaving() {
        let path = temp_path();
        let held =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54945, available: true })
                .expect("port");
        let error = held
            .migrate(&path, &FakeAllocator { selected: 54945, available: true })
            .expect_err("same port is not a migration");
        assert_eq!(error.code(), EditorErrorCode::PortConflict);
    }

    #[test]
    fn a_selected_origin_is_below_the_range_the_os_hands_out() {
        // Binding zero returns a port from the ephemeral range, which is the
        // range the OS is free to give to any other program the moment DevHub
        // is not holding it. That is what made the stable origin unstable.
        let port = SystemPortAllocator.choose().expect("chosen port");
        assert!(
            port < EPHEMERAL_PORT_FLOOR,
            "a stable origin must not be drawn from the ephemeral range: {port}"
        );
        assert!((STABLE_PORT_FIRST..=STABLE_PORT_LAST).contains(&port));
    }

    #[test]
    fn system_allocator_rejects_an_active_listener() {
        let listener =
            TcpListener::bind((super::super::paths::LOOPBACK_HOST, 0)).expect("active listener");
        let port = listener.local_addr().expect("listener address").port();
        assert!(!SystemPortAllocator.is_available(port));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_allocator_accepts_a_reusable_time_wait_origin() {
        let listener =
            TcpListener::bind((super::super::paths::LOOPBACK_HOST, 0)).expect("TIME_WAIT listener");
        let port = listener.local_addr().expect("listener address").port();
        let mut client = TcpStream::connect((super::super::paths::LOOPBACK_HOST, port))
            .expect("client connection");
        let (mut accepted, _) = listener.accept().expect("accepted connection");
        accepted.write_all(b"q5").expect("server write");
        drop(accepted);
        let mut payload = [0_u8; 2];
        client.read_exact(&mut payload).expect("client read");
        let mut eof = [0_u8; 1];
        assert_eq!(client.read(&mut eof).expect("server close"), 0);
        drop(client);
        drop(listener);

        assert!(
            SystemPortAllocator.is_available(port),
            "TIME_WAIT without an active listener must not become a stable-origin conflict"
        );
    }
}
