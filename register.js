function getApiBase() {
    return window.EpigaeaConfig.getApiBase();
}

document.getElementById('register-form').addEventListener('submit', async function (event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const adminCode = document.getElementById('admin-code').value.trim();
    const statusEl = document.getElementById('register-status');

    statusEl.style.display = 'none';
    statusEl.className = 'status-message';

    try {
        const response = await fetch(`${getApiBase()}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, adminCode })
        });
        const data = await response.json();

        if (data.success) {
            statusEl.textContent = data.isGlobalAdmin
                ? 'Global Admin account created! Redirecting to login...'
                : 'Account created! Redirecting to login...';
            statusEl.classList.add('success');
            statusEl.style.display = 'block';
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 900);
        } else {
            statusEl.textContent = data.message || 'Registration failed';
            statusEl.classList.add('error');
            statusEl.style.display = 'block';
        }
    } catch (error) {
        console.error('Error:', error);
        statusEl.textContent = 'Could not reach server.';
        statusEl.classList.add('error');
        statusEl.style.display = 'block';
    }
});
