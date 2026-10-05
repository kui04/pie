//! Which kind of machine this is.

use crate::error::PieError;

/// `"mobile"` (no window manager) or `"desktop"`.
///
/// Pie asks the host. CSS does not measure this. A window in the shape of a
/// phone is a desktop. A tablet in landscape mode is a phone. The value is
/// compiled in. Therefore it cannot change while the app operates.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a
/// claim about today's code. A compiled-in fact has nothing to fail on yet.
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
        // The string is the full contract. The other value is as unreachable as
        // the mobile branch below it.
        let answer = platform().expect("cannot fail");
        assert!(matches!(answer, "mobile" | "desktop"), "got {answer:?}");
    }
}
