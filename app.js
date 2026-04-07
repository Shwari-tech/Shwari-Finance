/**
 * Shwari Finance - PWA Logic & Security Gateway
 */

const MACRO_URL = "https://script.google.com/macros/s/AKfycbyfWRNzWAIdwm30l4I_M_Wj6FlVT2ToNY1LjJr3riHiud5Y2JnFw8XfrHwZBtKjZQwY/exec";

// 1. FORMAT NAME (e.g. "emilio thuku" -> "Emilio Thuku")
const formatName = (str) => {
    if (!str) return "";
    return str.toLowerCase().split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
};

// 2. CHECK PWA STANDALONE MODE (iPhone & Android)
const isPWA = () => {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true || 
           document.referrer.includes('android-app://');
};

// 3. INITIALIZE AUTHENTICATION (Called from index.html)
window.initAuth = () => {
    // SECURITY RESTRICTION: Block access if opened in a normal mobile browser tab
    if (!isPWA()) {
        document.getElementById('forcedInstall').style.display = 'flex';
        return; // Halt execution
    }

    const isRegistered = localStorage.getItem('shwari_registered');
    const authPortal = document.getElementById('auth-portal');
    authPortal.classList.remove('hidden');

    if (isRegistered === 'true') {
        // Setup "Continue As" Card
        const rawName = localStorage.getItem('emp_name');
        const email = localStorage.getItem('emp_email');
        
        document.getElementById('display-name').innerText = formatName(rawName);
        document.getElementById('display-email').innerText = email;
        
        document.getElementById('login-screen').classList.remove('hidden');
    } else {
        // Setup "Registration" Card
        document.getElementById('reg-screen').classList.remove('hidden');
    }
};

// 4. HANDLE REGISTRATION BUTTON
window.handleRegister = () => {
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim().toLowerCase();

    if (name && email) {
        localStorage.setItem('emp_name', name);
        localStorage.setItem('emp_email', email);
        localStorage.setItem('shwari_registered', 'true');
        
        // Reload cleanly to show the "Continue as" screen
        location.reload(); 
    } else {
        alert("Please enter both Name and Work Email.");
    }
};

// 5. HANDLE "CONTINUE" BUTTON
window.handleContinue = () => {
    // 1. Hide the auth UI
    document.getElementById('auth-portal').style.opacity = '0';
    setTimeout(() => {
        document.getElementById('auth-portal').style.display = 'none';
    }, 500);

    // 2. Inject the Secure Macro Link with Cache Bypass
    const iframe = document.getElementById('macro-frame');
    iframe.src = MACRO_URL + '?cb=' + new Date().getTime();

    // 3. Trigger your beautiful Digital Assimilation Animation
    if(typeof window.executeAssimilation === 'function') {
        window.executeAssimilation();
    }
};

// 6. RESET DEVICE (Admin/Emergency)
window.resetDevice = () => {
    if(confirm("Are you sure? This will remove your secure registration from this device.")) {
        localStorage.removeItem('emp_name');
        localStorage.removeItem('emp_email');
        localStorage.removeItem('shwari_registered');
        location.reload();
    }
};
