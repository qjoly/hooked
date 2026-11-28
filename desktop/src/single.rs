//! One app per Windows session. A second launch (a double click on the exe, the Start menu)
//! asks the first to come forward and exits, instead of adding a second process and a second tray
//! icon. `HOOKED_MULTI_INSTANCE=1` turns the guard off, for tests that need two apps side by side.
//! Other platforms already keep one instance per app.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, INFINITE, SetEvent, WaitForSingleObject,
    };

    const MUTEX: &str = "Local\\dev.qjoly.hooked-rune.single";
    const EVENT: &str = "Local\\dev.qjoly.hooked-rune.open";

    /// The event the running app waits on, as a raw handle; 0 until this process is the one.
    static EVENT_HANDLE: AtomicUsize = AtomicUsize::new(0);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    /// True when this process is the app to run. False when another one runs: it was told to come
    /// forward and this one has nothing left to do. The handles stay open until the process ends,
    /// which is what holds the name.
    pub fn acquire() -> bool {
        if std::env::var_os("HOOKED_MULTI_INSTANCE").is_some() {
            crate::tray::trace("single: guard off (HOOKED_MULTI_INSTANCE)");
            return true;
        }
        // SAFETY: the names are NUL-terminated and outlive the calls; the security attributes are
        // null (the defaults).
        unsafe {
            // The event first: a second launch that sees the mutex is sure to find it.
            let event = CreateEventW(std::ptr::null(), 0, 0, wide(EVENT).as_ptr());
            if event.is_null() {
                crate::tray::trace(&format!("single: no guard, event error {}", GetLastError()));
                return true;
            }
            let mutex = CreateMutexW(std::ptr::null(), 0, wide(MUTEX).as_ptr());
            if mutex.is_null() {
                crate::tray::trace(&format!("single: no guard, mutex error {}", GetLastError()));
                return true;
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                crate::tray::trace("single: another instance runs, asking it to come forward");
                SetEvent(event);
                return false;
            }
            crate::tray::trace("single: guard taken");
            EVENT_HANDLE.store(event as usize, Ordering::Relaxed);
        }
        true
    }

    /// Brings the window up each time a later launch asks for it.
    pub fn serve() {
        let event = EVENT_HANDLE.load(Ordering::Relaxed);
        if event == 0 {
            return;
        }
        std::thread::spawn(move || {
            // SAFETY: the handle is a live event that this process never closes.
            while unsafe { WaitForSingleObject(event as _, INFINITE) } == WAIT_OBJECT_0 {
                crate::tray::trace("single: a later launch asked to come forward");
                if let Some(h) = crate::app::HANDLE.get() {
                    h.open();
                }
            }
        });
    }
}

#[cfg(windows)]
pub use imp::{acquire, serve};

#[cfg(not(windows))]
pub fn acquire() -> bool {
    true
}

#[cfg(not(windows))]
pub fn serve() {}
