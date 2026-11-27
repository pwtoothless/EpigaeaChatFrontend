// Production backend URL (used when hosted on GitHub Pages / custom domain).
// On local dev ports (localhost:3000, etc.), local ports 8082/8081 are used automatically
// unless overridden with ?backend=... in the URL.
window.EPIGAEA_BACKEND_URL = "https://epigaea-api.mayflower-paradise.us";

window.EpigaeaConfig = (function () {
    const devPorts = ['3000', '3001', '4173', '5173', '5500', '8000', '8080'];
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

    function resolveConfiguredBackend() {
        const params = new URLSearchParams(window.location.search);
        const paramUrl = params.get('backend');
        if (paramUrl) {
            const clean = paramUrl.replace(/\/+$/, '');
            localStorage.setItem('epigaea_backend_url', clean);
            return clean;
        }
        const stored = localStorage.getItem('epigaea_backend_url');
        if (stored && stored.trim() !== '') {
            return stored.trim().replace(/\/+$/, '');
        }
        if (isLocalHost || devPorts.includes(window.location.port)) {
            return '';
        }
        return (window.EPIGAEA_BACKEND_URL || '').trim().replace(/\/+$/, '');
    }

    function getApiBase() {
        const configured = resolveConfiguredBackend();
        if (configured) return configured;

        if (window.location.protocol === 'file:' || devPorts.includes(window.location.port)) {
            const host = window.location.hostname || 'localhost';
            return `http://${host}:8082`;
        }
        return '';
    }

    function getWsUrl() {
        const configured = resolveConfiguredBackend();
        if (configured) {
            const wsBase = configured.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
            return `${wsBase}/api/wss`;
        }

        if (window.location.protocol === 'file:' || devPorts.includes(window.location.port)) {
            const host = window.location.hostname || 'localhost';
            return `ws://${host}:8081`;
        }
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${wsProtocol}//${window.location.host}/api/wss`;
    }

    return { getApiBase, getWsUrl };
})();
