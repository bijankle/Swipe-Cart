/**
 * App version + build stamp, shown on the Settings page.
 * BUILD_DATE is replaced with the real deploy timestamp by the Pages
 * workflow; locally it stays this placeholder.
 */
export const APP_VERSION = "0.5.1";
export const BUILD_DATE = "__BUILD_DATE__";

export function buildDateLabel() {
  if (BUILD_DATE.startsWith("__")) return "dev build (not deployed)";
  return new Date(BUILD_DATE).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
