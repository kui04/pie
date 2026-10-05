//! Which kind of machine this is.

use crate::error::PieError;

/// `"mobile"` (no window manager) or `"desktop"`.
///
/// Asked of the host rather than measured in CSS, because a phone-shaped desktop
/// window is still a desktop and a tablet in landscape is still a phone.
/// Compiled in, so it cannot change while the app runs.
///
/// # Errors
///
/// The boundary's shape, not a claim about today's code: a compiled-in fact has
/// nothing to fail on yet.
#[tauri::command]
pub fn platform() -> Result<&'static str, PieError> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return Ok("mobile");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Ok("desktop")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_answers_one_of_the_two_words_the_frontend_asks_about() {
        // The only test a compiled-in fact can have: the string it answers is
        // the whole contract, and the other one is as unreachable as the mobile
        // branch it sits behind.
        let answer = platform().expect("cannot fail");
        assert!(matches!(answer, "mobile" | "desktop"), "got {answer:?}");
    }
}
