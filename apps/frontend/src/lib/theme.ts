export const THEME_STORAGE_KEY = "zoft-theme";

// Runs before hydration (see app/layout.tsx) so the correct class is on
// <html> for the very first paint — no light-flash-then-dark on load.
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (isDark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;
