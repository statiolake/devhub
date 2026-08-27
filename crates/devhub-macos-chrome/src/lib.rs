//! macOS window-chrome geometry for the DevHub app shell.
//!
//! DevHub draws its own titlebar band, which is not the height AppKit assumes,
//! so the standard window buttons have to be placed against that band rather
//! than against the system default. Tao exposes an inset for this, but it is
//! measured from the button's offset inside AppKit's own button container, so
//! one number means different things on different systems. This crate owns the
//! placement outright and keeps the arithmetic separable from the AppKit call.

/// Where the leading window button belongs so that a row of buttons of
/// `button_height` sits on the centre line of a titlebar band `band_height`
/// tall, `leading` points in from the window's leading edge.
///
/// The vertical result is measured from the *bottom* of the band, which is how
/// AppKit's upward-growing window coordinates address it.
#[must_use]
pub fn button_origin(band_height: f64, button_height: f64, leading: f64) -> (f64, f64) {
    (leading, (band_height - button_height) / 2.0)
}

/// Place the window buttons of `ns_window` on the centre line of a titlebar
/// band `band_height` tall, `leading` points in from the leading edge.
///
/// AppKit rebuilds the button container whenever the window resizes, so this
/// has to be called again on every resize and not only once at startup. It is
/// idempotent: it derives the button spacing from the buttons themselves, so
/// re-running it never drifts.
///
/// Does nothing off the main thread or for a null handle, so a caller cannot
/// break AppKit's threading rule through this seam. `ns_window` is expected to
/// be the pointer a window toolkit hands back for a live window; a stale one
/// is the caller's to avoid, as it is for every other window API.
#[cfg(target_os = "macos")]
pub fn centre_window_buttons(ns_window: *mut std::ffi::c_void, band_height: f64, leading: f64) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    if ns_window.is_null() || objc2_foundation::MainThreadMarker::new().is_none() {
        return;
    }
    let window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|button| window.standardWindowButton(button));
    let [Some(close), Some(miniaturize), Some(zoom)] = buttons else {
        return;
    };
    // The container is the buttons' grandparent: AppKit groups them in a
    // wrapper inside the theme frame's titlebar container.
    let Some(container) =
        (unsafe { close.superview() }).and_then(|wrapper| unsafe { wrapper.superview() })
    else {
        return;
    };

    let (leading, bottom_inset) = button_origin(band_height, close.frame().size.height, leading);

    // Resize the container to DevHub's band and anchor it to the top of the
    // window, so the buttons stay inside it and stay hit-testable.
    let mut band = container.frame();
    band.size.height = band_height;
    band.origin.y = window.frame().size.height - band_height;
    container.setFrame(band);

    let spacing = miniaturize.frame().origin.x - close.frame().origin.x;
    for (index, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = leading + (index as f64) * spacing;
        origin.y = bottom_inset;
        button.setFrameOrigin(origin);
    }
}

/// Nothing is dereferenced off macOS; the signature matches for portability.
#[cfg(not(target_os = "macos"))]
pub fn centre_window_buttons(_ns_window: *mut std::ffi::c_void, _band_height: f64, _leading: f64) {}

#[cfg(test)]
mod tests {
    use super::button_origin;

    #[test]
    fn buttons_of_any_height_land_on_the_band_centre_line() {
        for button_height in [12.0, 14.0, 16.0] {
            let (x, y) = button_origin(38.0, button_height, 20.0);
            assert_eq!(x, 20.0);
            assert_eq!(y + button_height / 2.0, 38.0 / 2.0);
        }
    }

    #[test]
    fn a_band_the_system_height_reproduces_the_system_placement() {
        // A 28pt band with 14pt buttons is what AppKit itself draws, so the
        // helper must agree with the platform at the platform's own size.
        assert_eq!(button_origin(28.0, 14.0, 20.0), (20.0, 7.0));
    }
}
