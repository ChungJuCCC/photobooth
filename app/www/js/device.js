// Settings that belong to one tablet rather than to the booth.
//
// Frames, people and shoots live on the server, so changing them changes every
// tablet at once. Mirroring is not like that: it depends on how this tablet's
// camera is pointed and what the people in front of it expect to see, so it is
// kept in this device's own storage and never sent anywhere.

const MIRROR_STORE = "mirror";

let mirror = true; // a selfie view, which is what a booth camera has always been

export function mirrorOn() {
  return mirror;
}

export function setMirror(on) {
  mirror = !!on;
  document.body.classList.toggle("no-mirror", !mirror);
  try {
    localStorage.setItem(MIRROR_STORE, mirror ? "on" : "off");
  } catch {
    // storage blocked: the setting holds for this visit only
  }
}

export function loadDeviceSettings() {
  let stored = null;
  try {
    stored = localStorage.getItem(MIRROR_STORE);
  } catch {
    // storage blocked; the default stands
  }
  setMirror(stored === null ? true : stored === "on");
}
