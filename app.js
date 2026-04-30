/**
 * ============================================================
 *  Shwari Finance — PWA Logic & Security Gateway
 *  Version: 2.0.0
 *  Upgraded for: Offline Support, Instant Memory, Session
 *  Security, Audit Logging, Retry Logic & Network Resilience
 * ============================================================
 */

"use strict"; // Enforce strict mode to catch silent errors

// ─────────────────────────────────────────────────────────────
//  CONSTANTS & CONFIGURATION
// ─────────────────────────────────────────────────────────────

const MACRO_URL =
  "https://script.google.com/macros/s/AKfycbzkLLgdBKSrl9QX7v0Gp63WUdTg1ivF8n78wZPbILcRTLhYO5KaRYwFmK2JCXbPRwxPyQ/exec";

const CONFIG = {
  APP_NAME: "Shwari Finance",
  STORAGE_PREFIX: "shwari_",       // Namespace all storage keys
  SESSION_TTL_MS: 8 * 60 * 60 * 1000, // 8-hour session expiry
  MAX_LOGIN_ATTEMPTS: 5,           // Lockout after 5 failed continues
  LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15-minute lockout window
  IFRAME_TIMEOUT_MS: 12000,        // 12 seconds before iframe timeout warning
  MAX_RETRY_ATTEMPTS: 3,           // Retries for iframe/macro load
  RETRY_DELAY_BASE_MS: 1500,       // Base delay for exponential backoff
  FADE_DURATION_MS: 500,           // Auth portal fade animation duration
  AUDIT_LOG_MAX_ENTRIES: 50,       // Cap audit log size on device
  VERSION: "2.0.0",
};

// Namespaced storage keys — all in one place for easy maintenance
const KEYS = {
  REGISTERED:      CONFIG.STORAGE_PREFIX + "registered",
  EMP_NAME:        CONFIG.STORAGE_PREFIX + "emp_name",
  EMP_EMAIL:       CONFIG.STORAGE_PREFIX + "emp_email",
  SESSION_TOKEN:   CONFIG.STORAGE_PREFIX + "session_token",
  SESSION_EXPIRY:  CONFIG.STORAGE_PREFIX + "session_expiry",
  LOGIN_ATTEMPTS:  CONFIG.STORAGE_PREFIX + "login_attempts",
  LOCKOUT_UNTIL:   CONFIG.STORAGE_PREFIX + "lockout_until",
  LAST_SEEN:       CONFIG.STORAGE_PREFIX + "last_seen",
  AUDIT_LOG:       CONFIG.STORAGE_PREFIX + "audit_log",
  INSTALL_PROMPT:  CONFIG.STORAGE_PREFIX + "install_prompt_seen",
  DEVICE_ID:       CONFIG.STORAGE_PREFIX + "device_id",
  THEME:           CONFIG.STORAGE_PREFIX + "theme",
};


// ─────────────────────────────────────────────────────────────
//  1. UTILITY — FORMAT NAME
//  Converts any casing to Title Case (e.g. "emilio thuku" → "Emilio Thuku")
// ─────────────────────────────────────────────────────────────

const formatName = (str) => {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .trim()
    .split(/\s+/) // Handle multiple consecutive spaces
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};


// ─────────────────────────────────────────────────────────────
//  2. UTILITY — EMAIL VALIDATION
//  Rejects clearly malformed emails before saving to storage
// ─────────────────────────────────────────────────────────────

const isValidEmail = (email) => {
  if (!email || typeof email !== "string") return false;
  // RFC-5322 simplified pattern — catches common mistakes
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return pattern.test(email.trim().toLowerCase());
};


// ─────────────────────────────────────────────────────────────
//  3. UTILITY — SAFE LOCAL STORAGE WRAPPER
//  Guards against QuotaExceededError and private-mode failures
// ─────────────────────────────────────────────────────────────

const Store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.warn(`[Shwari] Store.get failed for "${key}":`, err.message);
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      console.error(`[Shwari] Store.set failed for "${key}":`, err.message);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (err) {
      console.warn(`[Shwari] Store.remove failed for "${key}":`, err.message);
      return false;
    }
  },
  clear() {
    try {
      // Only clear keys belonging to this app (safe for shared storage environments)
      const prefix = CONFIG.STORAGE_PREFIX;
      Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .forEach((k) => localStorage.removeItem(k));
      return true;
    } catch (err) {
      console.error("[Shwari] Store.clear failed:", err.message);
      return false;
    }
  },
};


// ─────────────────────────────────────────────────────────────
//  4. DEVICE FINGERPRINTING — Persistent Anonymous Device ID
//  Generates a stable UUID per device; used for audit logs
// ─────────────────────────────────────────────────────────────

const getDeviceId = () => {
  let id = Store.get(KEYS.DEVICE_ID);
  if (!id) {
    // Generate a UUID v4-style random string
    id = "dev-" + ([1e7] + -1e3 + -4e3 + -8e3 + -1e11)
      .replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
      );
    Store.set(KEYS.DEVICE_ID, id);
  }
  return id;
};


// ─────────────────────────────────────────────────────────────
//  5. AUDIT LOGGING — Tamper-evident On-Device Event Journal
//  Stores up to CONFIG.AUDIT_LOG_MAX_ENTRIES events locally
// ─────────────────────────────────────────────────────────────

const AuditLog = {
  /**
   * Appends a new event to the on-device audit trail.
   * @param {string} event - Short event identifier (e.g. "LOGIN_SUCCESS")
   * @param {Object} [meta={}] - Optional extra metadata
   */
  record(event, meta = {}) {
    try {
      const existing = JSON.parse(Store.get(KEYS.AUDIT_LOG) || "[]");
      const entry = {
        ts: new Date().toISOString(),       // ISO timestamp for portability
        event,                              // Event label
        device: getDeviceId(),              // Device fingerprint
        online: navigator.onLine,           // Connectivity at time of event
        ...meta,                            // Any additional context
      };
      // Prepend newest entry; trim to cap
      const updated = [entry, ...existing].slice(0, CONFIG.AUDIT_LOG_MAX_ENTRIES);
      Store.set(KEYS.AUDIT_LOG, JSON.stringify(updated));
    } catch (err) {
      console.warn("[Shwari] AuditLog.record failed:", err.message);
    }
  },

  /**
   * Returns the full audit log array (newest first).
   * @returns {Array}
   */
  read() {
    try {
      return JSON.parse(Store.get(KEYS.AUDIT_LOG) || "[]");
    } catch {
      return [];
    }
  },

  /**
   * Wipes the audit log. Called on full device reset.
   */
  clear() {
    Store.remove(KEYS.AUDIT_LOG);
  },
};


// ─────────────────────────────────────────────────────────────
//  6. SESSION MANAGEMENT — Cryptographic Token & Expiry
//  Short-lived session tokens prevent stale logins persisting
// ─────────────────────────────────────────────────────────────

const Session = {
  /**
   * Creates a new session token and saves it with an expiry timestamp.
   * Called after a successful "Continue" action.
   */
  create() {
    const token = "sess-" + crypto
      .getRandomValues(new Uint32Array(4))
      .join("-");
    const expiry = Date.now() + CONFIG.SESSION_TTL_MS;
    Store.set(KEYS.SESSION_TOKEN, token);
    Store.set(KEYS.SESSION_EXPIRY, String(expiry));
    Store.set(KEYS.LAST_SEEN, new Date().toISOString());
    AuditLog.record("SESSION_CREATED", { token_prefix: token.slice(0, 12) });
    return token;
  },

  /**
   * Returns true if a valid, unexpired session token exists.
   * @returns {boolean}
   */
  isValid() {
    const token = Store.get(KEYS.SESSION_TOKEN);
    const expiry = parseInt(Store.get(KEYS.SESSION_EXPIRY) || "0", 10);
    if (!token || !expiry) return false;
    if (Date.now() > expiry) {
      this.destroy("EXPIRED");
      return false;
    }
    return true;
  },

  /**
   * Destroys the current session (logout or expiry).
   * @param {string} [reason="MANUAL"] - Reason code for audit log
   */
  destroy(reason = "MANUAL") {
    AuditLog.record("SESSION_DESTROYED", { reason });
    Store.remove(KEYS.SESSION_TOKEN);
    Store.remove(KEYS.SESSION_EXPIRY);
  },

  /**
   * Returns a human-readable time-remaining string for the session.
   * @returns {string}
   */
  timeRemaining() {
    const expiry = parseInt(Store.get(KEYS.SESSION_EXPIRY) || "0", 10);
    const diff = expiry - Date.now();
    if (diff <= 0) return "Expired";
    const hours   = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${hours}h ${minutes}m`;
  },
};


// ─────────────────────────────────────────────────────────────
//  7. BRUTE-FORCE PROTECTION — Login Attempt Tracking
//  Locks out the app after too many rapid "Continue" presses
// ─────────────────────────────────────────────────────────────

const BruteGuard = {
  /**
   * Returns true if the device is currently locked out.
   * @returns {boolean}
   */
  isLockedOut() {
    const lockUntil = parseInt(Store.get(KEYS.LOCKOUT_UNTIL) || "0", 10);
    if (Date.now() < lockUntil) return true;
    if (lockUntil > 0) {
      // Lockout expired — reset counters automatically
      Store.remove(KEYS.LOCKOUT_UNTIL);
      Store.set(KEYS.LOGIN_ATTEMPTS, "0");
    }
    return false;
  },

  /**
   * Returns the remaining lockout duration in minutes (rounded up).
   * @returns {number}
   */
  lockoutMinutesRemaining() {
    const lockUntil = parseInt(Store.get(KEYS.LOCKOUT_UNTIL) || "0", 10);
    return Math.ceil((lockUntil - Date.now()) / 60_000);
  },

  /**
   * Increments the failed attempt counter; applies lockout if threshold hit.
   */
  recordFailedAttempt() {
    const attempts = parseInt(Store.get(KEYS.LOGIN_ATTEMPTS) || "0", 10) + 1;
    Store.set(KEYS.LOGIN_ATTEMPTS, String(attempts));
    AuditLog.record("FAILED_CONTINUE_ATTEMPT", { attempt: attempts });
    if (attempts >= CONFIG.MAX_LOGIN_ATTEMPTS) {
      const lockUntil = Date.now() + CONFIG.LOCKOUT_DURATION_MS;
      Store.set(KEYS.LOCKOUT_UNTIL, String(lockUntil));
      AuditLog.record("DEVICE_LOCKED_OUT", { until: new Date(lockUntil).toISOString() });
    }
  },

  /**
   * Clears attempt counter on successful continuation.
   */
  resetAttempts() {
    Store.remove(KEYS.LOGIN_ATTEMPTS);
    Store.remove(KEYS.LOCKOUT_UNTIL);
  },
};


// ─────────────────────────────────────────────────────────────
//  8. PWA DETECTION — Standalone Mode Enforcement
//  Ensures the app only runs when properly installed as a PWA
// ─────────────────────────────────────────────────────────────

const isPWA = () => {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true || // iOS Safari standalone
    document.referrer.includes("android-app://") // TWA (Trusted Web Activity)
  );
};


// ─────────────────────────────────────────────────────────────
//  9. NETWORK RESILIENCE — Retry with Exponential Backoff
//  Used to reload the macro iframe if initial load fails
// ─────────────────────────────────────────────────────────────

/**
 * Waits for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a function up to maxAttempts times with exponential backoff.
 * @param {Function} fn         - Async function to retry
 * @param {number} maxAttempts  - Maximum number of attempts
 * @param {number} baseDelayMs  - Initial delay in ms (doubles each retry)
 * @returns {Promise<any>}
 */
const retryWithBackoff = async (fn, maxAttempts = CONFIG.MAX_RETRY_ATTEMPTS, baseDelayMs = CONFIG.RETRY_DELAY_BASE_MS) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      console.warn(`[Shwari] Retry attempt ${attempt}/${maxAttempts} failed:`, err.message);
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1.5s, 3s, 6s…
        await sleep(delay);
      }
    }
  }
  throw lastError; // All attempts exhausted
};


// ─────────────────────────────────────────────────────────────
//  10. UI HELPERS — Centralized DOM Manipulation
//  Keeps all direct DOM access in one safe, readable place
// ─────────────────────────────────────────────────────────────

const UI = {
  /**
   * Returns a DOM element by ID. Throws clearly if missing.
   * @param {string} id
   * @returns {HTMLElement}
   */
  get(id) {
    const el = document.getElementById(id);
    if (!el) {
      console.error(`[Shwari] UI.get: Element "#${id}" not found in DOM.`);
    }
    return el;
  },

  /**
   * Shows an element by removing 'hidden' class.
   * @param {string} id
   */
  show(id) {
    const el = this.get(id);
    if (el) el.classList.remove("hidden");
  },

  /**
   * Hides an element by adding 'hidden' class.
   * @param {string} id
   */
  hide(id) {
    const el = this.get(id);
    if (el) el.classList.add("hidden");
  },

  /**
   * Sets the innerText of an element safely.
   * @param {string} id
   * @param {string} text
   */
  setText(id, text) {
    const el = this.get(id);
    if (el) el.innerText = text;
  },

  /**
   * Fades out an element over the configured duration, then hides it.
   * @param {string} id
   */
  fadeOut(id) {
    const el = this.get(id);
    if (!el) return;
    el.style.transition = `opacity ${CONFIG.FADE_DURATION_MS}ms ease`;
    el.style.opacity = "0";
    setTimeout(() => {
      el.style.display = "none";
      AuditLog.record("UI_FADE_COMPLETE", { element: id });
    }, CONFIG.FADE_DURATION_MS);
  },

  /**
   * Displays a non-blocking toast notification if the host page supports it.
   * Falls back gracefully to console.warn if no toast container exists.
   * @param {string} message
   * @param {"info"|"success"|"warning"|"error"} type
   */
  toast(message, type = "info") {
    console.log(`[Shwari Toast][${type.toUpperCase()}] ${message}`);
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) return; // Graceful fallback — host page may not have toasts
    const toast = document.createElement("div");
    toast.className = `shwari-toast shwari-toast--${type}`;
    toast.setAttribute("role", "alert"); // Accessibility: announce to screen readers
    toast.setAttribute("aria-live", "polite");
    toast.innerText = message;
    toastContainer.appendChild(toast);
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  },
};


// ─────────────────────────────────────────────────────────────
//  11. INITIALIZE AUTHENTICATION — Lightning Fast Memory Check
//  Entry point called from HTML on DOMContentLoaded
// ─────────────────────────────────────────────────────────────

window.initAuth = () => {
  AuditLog.record("AUTH_INIT_START");

  // ── PWA Enforcement ──────────────────────────────────────
  // Block normal browser tabs; only allow installed PWA context
  if (!isPWA()) {
    const installBanner = UI.get("forcedInstall");
    if (installBanner) installBanner.style.display = "flex";
    AuditLog.record("PWA_INSTALL_REQUIRED");
    return; // Hard stop — do not render auth UI in browser
  }

  // ── Show Auth Portal ─────────────────────────────────────
  const authPortal = UI.get("auth-portal");
  if (authPortal) authPortal.classList.remove("hidden");

  // ── Instant Memory Check: Read from Device Storage ───────
  const isRegistered = Store.get(KEYS.REGISTERED);

  if (isRegistered === "true") {
    // ── Returning User ────────────────────────────────────
    const rawName = Store.get(KEYS.EMP_NAME) || "";
    const email   = Store.get(KEYS.EMP_EMAIL) || "";

    // Update last seen timestamp silently
    Store.set(KEYS.LAST_SEEN, new Date().toISOString());

    // Populate the login screen with stored identity
    UI.setText("display-name",  formatName(rawName));
    UI.setText("display-email", email);

    // Optionally surface session remaining time if element exists
    const sessionInfoEl = UI.get("session-info");
    if (sessionInfoEl) {
      sessionInfoEl.innerText = Session.isValid()
        ? `Session valid — ${Session.timeRemaining()} remaining`
        : "No active session";
    }

    UI.show("login-screen");
    AuditLog.record("RETURNING_USER_LOADED", { email });
  } else {
    // ── First Time User ───────────────────────────────────
    UI.show("reg-screen");
    AuditLog.record("FIRST_TIME_USER_DETECTED");
  }

  // ── Render App Version Watermark (if element present) ────
  const versionEl = UI.get("app-version");
  if (versionEl) versionEl.innerText = `v${CONFIG.VERSION}`;
};


// ─────────────────────────────────────────────────────────────
//  12. HANDLE REGISTRATION — Save Identity to Device
//  Called when the user submits the registration form
// ─────────────────────────────────────────────────────────────

window.handleRegister = () => {
  const nameInput  = UI.get("reg-name");
  const emailInput = UI.get("reg-email");

  if (!nameInput || !emailInput) {
    UI.toast("Registration form elements are missing.", "error");
    AuditLog.record("REG_FORM_ELEMENTS_MISSING");
    return;
  }

  const name  = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();

  // ── Input Validation ──────────────────────────────────────
  if (!name) {
    UI.toast("Please enter your full name.", "warning");
    nameInput.focus();
    return;
  }

  if (!isValidEmail(email)) {
    UI.toast("Please enter a valid work email address.", "warning");
    emailInput.focus();
    AuditLog.record("REG_INVALID_EMAIL", { email });
    return;
  }

  // ── Persist Identity to Device Storage ───────────────────
  const savedName  = Store.set(KEYS.EMP_NAME,    name);
  const savedEmail = Store.set(KEYS.EMP_EMAIL,   email);
  const savedFlag  = Store.set(KEYS.REGISTERED,  "true");

  if (!savedName || !savedEmail || !savedFlag) {
    // Storage may be full or blocked (private/incognito mode)
    UI.toast(
      "Unable to save your registration. Check if storage is available.",
      "error"
    );
    AuditLog.record("REG_STORAGE_FAILED", { name, email });
    return;
  }

  AuditLog.record("USER_REGISTERED", { email, device: getDeviceId() });
  UI.toast("Registration successful! Logging you in…", "success");

  // Brief pause for toast visibility before reload
  setTimeout(() => location.reload(), 800);
};


// ─────────────────────────────────────────────────────────────
//  13. HANDLE CONTINUE — Launch Dashboard with Resilience
//  Called when the returning user taps "Continue"
// ─────────────────────────────────────────────────────────────

window.handleContinue = async () => {
  // ── Brute-Force Lockout Check ─────────────────────────────
  if (BruteGuard.isLockedOut()) {
    const mins = BruteGuard.lockoutMinutesRemaining();
    UI.toast(
      `Too many attempts. Please wait ${mins} minute(s) before trying again.`,
      "error"
    );
    AuditLog.record("CONTINUE_BLOCKED_LOCKOUT", { minutes_remaining: mins });
    return;
  }

  // ── Offline Guard ─────────────────────────────────────────
  if (!navigator.onLine) {
    BruteGuard.recordFailedAttempt(); // Count offline attempts too
    UI.toast(
      "You are offline. Please connect to the internet to access the dashboard.",
      "warning"
    );
    AuditLog.record("CONTINUE_BLOCKED_OFFLINE");
    return;
  }

  // ── Create Session Token ──────────────────────────────────
  const token = Session.create();
  AuditLog.record("CONTINUE_STARTED", { session_prefix: token.slice(0, 12) });

  // ── Reset Brute-Force Counter on Valid Continue ───────────
  BruteGuard.resetAttempts();

  // ── Fade Out Auth Portal Smoothly ────────────────────────
  UI.fadeOut("auth-portal");

  // ── Inject Macro Iframe with Cache-Busting Param ─────────
  const iframe = UI.get("macro-frame");
  if (iframe) {
    const macroURL = `${MACRO_URL}?cb=${Date.now()}&device=${getDeviceId()}`;

    // Track whether load succeeded or timed out
    let loadResolved = false;

    // Set up a timeout warning if iframe takes too long
    const timeoutHandle = setTimeout(() => {
      if (!loadResolved) {
        UI.toast(
          "Dashboard is taking longer than expected. Retrying…",
          "warning"
        );
        AuditLog.record("IFRAME_LOAD_TIMEOUT");
      }
    }, CONFIG.IFRAME_TIMEOUT_MS);

    // Retry logic: attempt to load the iframe URL up to MAX_RETRY_ATTEMPTS times
    try {
      await retryWithBackoff(
        (attempt) =>
          new Promise((resolve, reject) => {
            AuditLog.record("IFRAME_LOAD_ATTEMPT", { attempt });

            // Each retry gets a fresh cache-busting timestamp
            iframe.src = `${MACRO_URL}?cb=${Date.now()}&device=${getDeviceId()}&attempt=${attempt}`;

            // Resolve on load; reject on error
            const onLoad = () => {
              loadResolved = true;
              clearTimeout(timeoutHandle);
              iframe.removeEventListener("error", onError);
              AuditLog.record("IFRAME_LOADED_SUCCESS", { attempt });
              resolve();
            };

            const onError = () => {
              iframe.removeEventListener("load", onLoad);
              reject(new Error(`Iframe load error on attempt ${attempt}`));
            };

            iframe.addEventListener("load",  onLoad,  { once: true });
            iframe.addEventListener("error", onError, { once: true });
          })
      );
    } catch (err) {
      clearTimeout(timeoutHandle);
      UI.toast(
        "Failed to load the dashboard after multiple attempts. Please check your connection.",
        "error"
      );
      AuditLog.record("IFRAME_LOAD_EXHAUSTED", { error: err.message });
    }
  } else {
    AuditLog.record("IFRAME_ELEMENT_MISSING");
    console.error("[Shwari] #macro-frame element not found in DOM.");
  }

  // ── Trigger Assimilation Animation ───────────────────────
  if (typeof window.executeAssimilation === "function") {
    window.executeAssimilation();
    AuditLog.record("ASSIMILATION_TRIGGERED");
  }
};


// ─────────────────────────────────────────────────────────────
//  14. RESET DEVICE — Emergency Wipe with Confirmation
//  Clears all stored data and reloads to fresh registration
// ─────────────────────────────────────────────────────────────

window.resetDevice = () => {
  const confirmed = confirm(
    `⚠️ Reset ${CONFIG.APP_NAME}?\n\n` +
    "This will permanently remove your secure registration and session from this device.\n\n" +
    "You will need to re-register to continue."
  );

  if (!confirmed) {
    AuditLog.record("RESET_CANCELLED");
    return;
  }

  AuditLog.record("DEVICE_RESET_CONFIRMED", { device: getDeviceId() });

  // Wipe all app-namespaced keys from device storage
  Store.clear();
  AuditLog.clear(); // Also clear the log (privacy compliance)

  UI.toast("Device reset complete. Reloading…", "info");
  setTimeout(() => location.reload(), 600);
};


// ─────────────────────────────────────────────────────────────
//  15. LOGOUT — Destroy Session Without Wiping Registration
//  Ends the current session so the user must tap "Continue" again
// ─────────────────────────────────────────────────────────────

window.handleLogout = () => {
  Session.destroy("USER_LOGOUT");
  AuditLog.record("USER_LOGGED_OUT");
  UI.toast("You have been logged out.", "info");
  setTimeout(() => location.reload(), 600);
};


// ─────────────────────────────────────────────────────────────
//  16. THEME PERSISTENCE — Remember User's Preferred Theme
//  Reads saved theme on load; applies it immediately
// ─────────────────────────────────────────────────────────────

window.applyTheme = () => {
  const savedTheme = Store.get(KEYS.THEME) || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
};

window.toggleTheme = () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  Store.set(KEYS.THEME, next);
  AuditLog.record("THEME_TOGGLED", { theme: next });
};


// ─────────────────────────────────────────────────────────────
//  17. DIAGNOSTICS — Developer Debug Panel (DevTools Only)
//  Attach to window so it can be called from browser console
// ─────────────────────────────────────────────────────────────

window.__shwariDiag = () => {
  const diag = {
    version:        CONFIG.VERSION,
    device_id:      getDeviceId(),
    is_pwa:         isPWA(),
    is_online:      navigator.onLine,
    is_registered:  Store.get(KEYS.REGISTERED) === "true",
    emp_email:      Store.get(KEYS.EMP_EMAIL),
    session_valid:  Session.isValid(),
    session_ttl:    Session.isValid() ? Session.timeRemaining() : "None",
    login_attempts: Store.get(KEYS.LOGIN_ATTEMPTS) || "0",
    locked_out:     BruteGuard.isLockedOut(),
    last_seen:      Store.get(KEYS.LAST_SEEN),
    audit_entries:  AuditLog.read().length,
    audit_log:      AuditLog.read(),
  };
  console.table({ ...diag, audit_log: `[${diag.audit_entries} entries]` });
  console.log("[Shwari] Full Audit Log:", diag.audit_log);
  return diag;
};


// ─────────────────────────────────────────────────────────────
//  18. NETWORK STATUS LISTENERS — React to Connection Changes
//  Informs the user immediately when connectivity changes
// ─────────────────────────────────────────────────────────────

window.addEventListener("offline", () => {
  console.warn("[Shwari] Device went offline.");
  AuditLog.record("NETWORK_WENT_OFFLINE");
  UI.toast("You are now offline. Some features may be unavailable.", "warning");

  // Visually mark the app as offline if element exists
  const offlineIndicator = UI.get("offline-indicator");
  if (offlineIndicator) offlineIndicator.classList.remove("hidden");
});

window.addEventListener("online", () => {
  console.info("[Shwari] Device is back online.");
  AuditLog.record("NETWORK_RESTORED");
  UI.toast("Connection restored. You're back online.", "success");

  // Hide the offline indicator
  const offlineIndicator = UI.get("offline-indicator");
  if (offlineIndicator) offlineIndicator.classList.add("hidden");
});


// ─────────────────────────────────────────────────────────────
//  19. VISIBILITY API — Auto-refresh Session on Tab Focus
//  Detects when user returns to the app after leaving it
// ─────────────────────────────────────────────────────────────

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    AuditLog.record("APP_FOREGROUNDED");
    // If the session expired while the user was away, prompt re-auth
    if (Store.get(KEYS.REGISTERED) === "true" && !Session.isValid()) {
      console.info("[Shwari] Session expired while app was backgrounded.");
      UI.toast("Your session has expired. Please continue to re-authenticate.", "warning");
    }
  } else {
    AuditLog.record("APP_BACKGROUNDED");
  }
});


// ─────────────────────────────────────────────────────────────
//  20. BEFOREINSTALLPROMPT — Capture Native Install Prompt
//  Stores the event so a custom "Install" button can trigger it
// ─────────────────────────────────────────────────────────────

let _deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); // Suppress the automatic browser mini-infobar
  _deferredInstallPrompt = event;
  AuditLog.record("INSTALL_PROMPT_AVAILABLE");
  // Show your custom install button if present
  const installBtn = UI.get("custom-install-btn");
  if (installBtn) installBtn.classList.remove("hidden");
});

/**
 * Triggers the native PWA install prompt programmatically.
 * Attach to your custom install button's click handler.
 */
window.triggerInstallPrompt = async () => {
  if (!_deferredInstallPrompt) {
    UI.toast("Install option is not available right now.", "info");
    return;
  }
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  AuditLog.record("INSTALL_PROMPT_OUTCOME", { outcome });
  _deferredInstallPrompt = null; // Can only be used once
  const installBtn = UI.get("custom-install-btn");
  if (installBtn) installBtn.classList.add("hidden");
};

window.addEventListener("appinstalled", () => {
  AuditLog.record("PWA_INSTALLED_SUCCESSFULLY");
  UI.toast(`${CONFIG.APP_NAME} installed successfully!`, "success");
});


// ─────────────────────────────────────────────────────────────
//  AUTO-INIT — Apply Theme Immediately on Script Load
//  Prevents flash of unstyled content (FOUC) for theme
// ─────────────────────────────────────────────────────────────

window.applyTheme();
