//! Whether Windows draws apps dark, read from the registry. The window layer reports a change of
//! the Windows theme late or not at all, so on Windows the System theme follows this value.
//! Elsewhere the window layer's value is used as it is.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};

    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};

    /// 0 not read yet (or unreadable), 1 light, 2 dark.
    static DARK: AtomicU8 = AtomicU8::new(0);
    static CHECKED: AtomicU64 = AtomicU64::new(0);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn read() -> Option<bool> {
        let key = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
        let value = wide("AppsUseLightTheme");
        let (mut data, mut size) = (1u32, 4u32);
        // SAFETY: both names are NUL-terminated and outlive the call; `data` holds `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(data == 0)
    }

    /// Reads the setting again, at most once a second; true when it changed.
    pub fn refresh(now_ms: u64) -> bool {
        if now_ms / 1000 == CHECKED.swap(now_ms / 1000, Ordering::Relaxed) {
            return false;
        }
        let next = match read() {
            Some(true) => 2,
            Some(false) => 1,
            None => 0,
        };
        DARK.swap(next, Ordering::Relaxed) != next
    }

    pub fn apply(window_says: bool) -> bool {
        match DARK.load(Ordering::Relaxed) {
            1 => false,
            2 => true,
            _ => window_says,
        }
    }
}

#[cfg(windows)]
pub use imp::{apply, refresh};

#[cfg(not(windows))]
pub fn refresh(_now_ms: u64) -> bool {
    false
}

#[cfg(not(windows))]
pub fn apply(window_says: bool) -> bool {
    window_says
}
