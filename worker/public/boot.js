// Runs before first paint (classic script in <head>) so a saved theme, a collapsed sidebar or a
// chosen text size never flashes the default first. theme.js, sidebar.js and prefs.js own these
// settings once the app has loaded.
try {
  const root = document.documentElement;
  // The approved workspace starts light; explicit Dark and System choices persist.
  const theme = localStorage.getItem("qwen.theme");
  if (theme !== "system") root.dataset.theme = theme === "dark" ? "dark" : "light";
  if (localStorage.getItem("qwen.sidebar") === "collapsed") root.dataset.sidebar = "collapsed";
  const prefs = JSON.parse(localStorage.getItem("qwen.prefs") || "{}");
  const sizes = { xsmall: 12, small: 13, medium: 14, big: 15 };
  const codeSizes = { xsmall: 11, small: 11.5, medium: 12, big: 13 };
  const widths = { comfortable: 880, wide: 1120 };
  const size = prefs.readingVersion === 2 && sizes[prefs.textSize] ? prefs.textSize : "medium";
  const width = prefs.readingVersion === 2 && widths[prefs.width] ? prefs.width : "wide";
  root.style.setProperty("--reading-size", `${sizes[size]}px`);
  root.style.setProperty("--code-size", `${codeSizes[size]}px`);
  root.style.setProperty("--measure", `${widths[width]}px`);
} catch {
  // Storage is blocked (private mode, site data off) or holds junk: the defaults apply.
}
