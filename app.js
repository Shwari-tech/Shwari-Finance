/**
 * Shwari Finance - PWA Logic & Security Gateway
 * Upgraded for Offline Support & Instant Memory
 */

const MACRO_URL = "https://script.google.com/macros/s/AKfycbyfWRNzWAIdwm30l4I_M_Wj6FlVT2ToNY1LjJr3riHiud5Y2JnFw8XfrHwZBtKjZQwY/exec";

// 1. FORMAT NAME (e.g. "emilio thuku" -> "Emilio Thuku")
const formatName = (str) => {
    if (!str) return "";
    return str.toLowerCase().split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
};

// 2. CHECK PWA STANDALONE MODE (Ensures it is installed)
const isPWA = () => {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true || 
           document.referrer.includes('android-app://');
};

// 3. INITIALIZE AUTHENTICATION (Lightning Fast Memory)
window.initAuth = () => {
    // Block normal browser tabs to enforce security
    if (!isPWA()) {
        document.getElementById('forcedInstall').style.display = 'flex';
        return; 
    }

    // INSTANT MEMORY CHECK: Read directly from device hard drive
    const isRegistered = localStorage.getItem('shwari_registered');
    const authPortal = document.getElementById('auth-portal');
    authPortal.classList.remove('hidden');

    if (isRegistered === 'true') {
        // Fast Retrieval of Saved Data
        const rawName = localStorage.getItem('emp_name');
        const email = localStorage.getItem('emp_email');
        
        document.getElementById('display-name').innerText = formatName(rawName);
        document.getElementById('display-email').innerText = email;
        
        document.getElementById('login-screen').classList.remove('hidden');
    } else {
        // First Time User
        document.getElementById('reg-screen').classList.remove('hidden');
    }
};

// 4. HANDLE REGISTRATION BUTTON (Save Data to Device)
window.handleRegister = () => {
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim().toLowerCase();

    if (name && email) {
        // SAVE DATA OFFLINE: This writes to the phone's permanent memory
        localStorage.setItem('emp_name', name);
        localStorage.setItem('emp_email', email);
        localStorage.setItem('shwari_registered', 'true');
        
        location.reload(); 
    } else {
        alert("Please enter both Name and Work Email.");
    }
};

// 5. HANDLE "CONTINUE" BUTTON (With Offline Protection)
window.handleContinue = () => {
    // OFFLINE CHECK: Prevent app crash if user has no data/wifi
    if (!navigator.onLine) {
        alert("You are currently offline. Please connect to the internet to access the Shwari Finance Dashboard.");
        return; // Stop here if offline
    }

    // 1. Hide the auth UI smoothly
    const authPortal = document.getElementById('auth-portal');
    authPortal.style.opacity = '0';
    setTimeout(() => {
        authPortal.style.display = 'none';
    }, 500);

    // 2. Inject Secure Macro Link (Only happens if online)
    const iframe = document.getElementById('macro-frame');
    iframe.src = MACRO_URL + '?cb=' + new Date().getTime();

    // 3. Trigger Assimilation Animation
    if(typeof window.executeAssimilation === 'function') {
        window.executeAssimilation();
    }
};

// 6. RESET DEVICE (Emergency Wipe)
window.resetDevice = () => {
    if(confirm("Are you sure? This will remove your secure registration from this device.")) {
        // Wipes the offline memory
        localStorage.clear(); 
        location.reload();
    }
};

// 7. LISTEN FOR NETWORK CHANGES (Optional but recommended for PWA)
window.addEventListener('offline', () => {
    console.log("Device went offline.");
});
window.addEventListener('online', () => {
    console.log("Device is back online.");
});
