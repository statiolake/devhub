//! Loopback origin availability.

/// Whether a loopback port can be listened on.
///
/// DevHub does not pick the editor origin — it asks the server for port zero
/// and reads back what the server bound, so there is never a moment between
/// choosing a port and holding it. This is only used the other way round: to
/// confirm a stopped server actually let its port go.
pub trait PortAllocator: Send + Sync {
    fn is_available(&self, port: u16) -> bool;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemPortAllocator;

impl PortAllocator for SystemPortAllocator {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn an_active_listener_is_not_available() {
        let listener =
            TcpListener::bind((super::super::paths::LOOPBACK_HOST, 0)).expect("active listener");
        let port = listener.local_addr().expect("listener address").port();
        assert!(!SystemPortAllocator.is_available(port));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_reusable_time_wait_origin_is_available() {
        // A stopped server leaves TIME_WAIT behind. Reading that as still
        // occupied would make every clean shutdown look like a failed one.
        let listener =
            TcpListener::bind((super::super::paths::LOOPBACK_HOST, 0)).expect("TIME_WAIT listener");
        let port = listener.local_addr().expect("listener address").port();
        let mut client = TcpStream::connect((super::super::paths::LOOPBACK_HOST, port))
            .expect("client connection");
        let (mut accepted, _) = listener.accept().expect("accepted connection");
        accepted.write_all(b"ok").expect("server write");
        drop(accepted);
        let mut payload = [0_u8; 2];
        client.read_exact(&mut payload).expect("client read");
        let mut eof = [0_u8; 1];
        assert_eq!(client.read(&mut eof).expect("server close"), 0);
        drop(client);
        drop(listener);

        assert!(SystemPortAllocator.is_available(port));
    }
}
