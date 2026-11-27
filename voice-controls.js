// Epigaea Voice & Microphone Control Engine (v1.1.0)
// Provides hardware constraints (noise suppression, echo cancellation, AGC),
// Web Audio DSP (gain, high-pass filter, compressor, noise gate, VU meter),
// and real-time Auto-Tune / pitch-shift via AudioWorklet.

window.EpigaeaVoice = (function () {
    const STORAGE_KEY = 'epigaea_voice_settings';

    const DEFAULT_SETTINGS = {
        inputDeviceId: '',
        outputDeviceId: '',
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        gain: 1.0,
        noiseGateThreshold: 8,
        compressorEnabled: true,
        highPassEnabled: true,
        autoTuneEnabled: false,
        autoTuneScale: 'chromatic',
        pitchShiftSemitones: 0,
        retuneSpeed: 0.85
    };

    const SCALES = {
        chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        major_c: [0, 2, 4, 5, 7, 9, 11],
        minor_a: [0, 2, 3, 5, 7, 8, 10],
        major_g: [0, 2, 4, 6, 7, 9, 11],
        robot: [0]
    };

    const WORKLET_CODE = `
    class EpigaeaAutoTuneProcessor extends AudioWorkletProcessor {
        static get parameterDescriptors() {
            return [
                { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1 },
                { name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12 },
                { name: 'retuneSpeed', defaultValue: 0.85, minValue: 0.05, maxValue: 1.0 },
                { name: 'scaleMode', defaultValue: 0, minValue: 0, maxValue: 4 }
            ];
        }

        constructor() {
            super();
            this.bufSize = 4096;
            this.inBuf = new Float32Array(this.bufSize);
            this.inIdx = 0;
            this.outBuf = new Float32Array(this.bufSize);
            this.readPos = 0;
            this.phase = 0;
            this.currentRatio = 1.0;
            this.frameCount = 0;
            this.scales = [
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
                [0, 2, 4, 5, 7, 9, 11],
                [0, 2, 3, 5, 7, 8, 10],
                [0, 2, 4, 6, 7, 9, 11],
                [0]
            ];
        }

        detectPitch(buf, sr) {
            const minLag = Math.floor(sr / 500);
            const maxLag = Math.floor(sr / 75);
            let bestLag = -1;
            let bestCorr = 0;
            let energy = 0;
            const len = 1024;
            for (let i = 0; i < len; i++) {
                const s = buf[(this.inIdx - len + i + this.bufSize) % this.bufSize];
                energy += s * s;
            }
            if (energy < 0.0005) return 0;

            for (let lag = minLag; lag <= maxLag; lag++) {
                let corr = 0;
                for (let i = 0; i < len - lag; i++) {
                    const a = buf[(this.inIdx - len + i + this.bufSize) % this.bufSize];
                    const b = buf[(this.inIdx - len + i + lag + this.bufSize) % this.bufSize];
                    corr += a * b;
                }
                if (corr > bestCorr) {
                    bestCorr = corr;
                    bestLag = lag;
                }
            }
            if (bestLag <= 0 || bestCorr < energy * 0.35) return 0;
            return sr / bestLag;
        }

        quantizeMidi(midi, scaleIdx) {
            const scale = this.scales[scaleIdx] || this.scales[0];
            if (scaleIdx === 4) {
                // Robot/monotone lock near C3 (MIDI 48)
                return 48;
            }
            const octave = Math.floor(midi / 12);
            const pc = midi - octave * 12;
            let best = scale[0];
            let bestDist = 99;
            for (let i = 0; i < scale.length; i++) {
                const d = Math.abs(pc - scale[i]);
                if (d < bestDist) {
                    bestDist = d;
                    best = scale[i];
                }
            }
            return octave * 12 + best;
        }

        process(inputs, outputs, parameters) {
            const input = inputs[0];
            const output = outputs[0];
            if (!input || !input[0] || !output || !output[0]) return true;

            const inCh = input[0];
            const outCh = output[0];
            const enabled = parameters.enabled[0] > 0.5;
            const semitones = parameters.semitones[0];
            const retune = parameters.retuneSpeed[0];
            const scaleIdx = Math.round(parameters.scaleMode[0]);

            if (!enabled) {
                for (let i = 0; i < inCh.length; i++) outCh[i] = inCh[i];
                return true;
            }

            for (let i = 0; i < inCh.length; i++) {
                this.inBuf[this.inIdx] = inCh[i];
                this.inIdx = (this.inIdx + 1) % this.bufSize;
            }

            this.frameCount += inCh.length;
            if (this.frameCount >= 512) {
                this.frameCount = 0;
                const detectedHz = this.detectPitch(this.inBuf, sampleRate);
                let targetRatio = Math.pow(2, semitones / 12);
                if (detectedHz > 60 && detectedHz < 900) {
                    const midi = 69 + 12 * Math.log2(detectedHz / 440);
                    const snapped = this.quantizeMidi(midi, scaleIdx) + semitones;
                    const targetHz = 440 * Math.pow(2, (snapped - 69) / 12);
                    targetRatio = Math.max(0.5, Math.min(2.0, targetHz / detectedHz));
                }
                this.currentRatio += (targetRatio - this.currentRatio) * retune;
            }

            // Dual-tap overlap-add pitch shifter
            const grain = 1024;
            for (let i = 0; i < inCh.length; i++) {
                this.phase = (this.phase + (1.0 - this.currentRatio) / grain) % 1.0;
                if (this.phase < 0) this.phase += 1.0;
                const p2 = (this.phase + 0.5) % 1.0;

                const d1 = this.phase * grain;
                const d2 = p2 * grain;

                const idx1 = (this.inIdx - inCh.length + i - Math.floor(d1) + this.bufSize * 2) % this.bufSize;
                const idx2 = (this.inIdx - inCh.length + i - Math.floor(d2) + this.bufSize * 2) % this.bufSize;

                const w1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
                const w2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);

                outCh[i] = this.inBuf[idx1] * w1 + this.inBuf[idx2] * w2;
            }
            return true;
        }
    }
    registerProcessor('epigaea-autotune', EpigaeaAutoTuneProcessor);
    `;

    let settings = loadSettings();
    let isMuted = false;
    let isDeafened = false;
    let prevMuteBeforeDeafen = false;
    let micTestActive = false;

    let rawStream = null;
    let processedStream = null;
    let audioCtx = null;
    let workletLoaded = false;
    let pipeline = null;
    let levelTimer = null;
    let onSpeakingChangeCb = null;

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        } catch (_) {}
        return { ...DEFAULT_SETTINGS };
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (_) {}
    }

    async function ensureAudioContext() {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            await audioCtx.resume().catch(() => {});
        }
        if (audioCtx && audioCtx.audioWorklet && !workletLoaded) {
            try {
                const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                await audioCtx.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
                workletLoaded = true;
            } catch (e) {
                console.warn('AudioWorklet load failed, auto-tune disabled:', e);
            }
        }
        return audioCtx;
    }

    function scaleToIndex(name) {
        return ['chromatic', 'major_c', 'minor_a', 'major_g', 'robot'].indexOf(name);
    }

    async function buildPipeline(stream) {
        teardownPipelineOnly();
        const ctx = await ensureAudioContext();
        if (!ctx) {
            processedStream = stream;
            return stream;
        }

        const source = ctx.createMediaStreamSource(stream);

        const highPass = ctx.createBiquadFilter();
        highPass.type = 'highpass';
        highPass.frequency.value = settings.highPassEnabled ? 90 : 10;

        const inputGain = ctx.createGain();
        inputGain.gain.value = settings.gain;

        let autoTuneNode = null;
        if (workletLoaded) {
            try {
                autoTuneNode = new AudioWorkletNode(ctx, 'epigaea-autotune');
                autoTuneNode.parameters.get('enabled').value = settings.autoTuneEnabled ? 1 : 0;
                autoTuneNode.parameters.get('semitones').value = settings.pitchShiftSemitones;
                autoTuneNode.parameters.get('retuneSpeed').value = settings.retuneSpeed;
                autoTuneNode.parameters.get('scaleMode').value = Math.max(0, scaleToIndex(settings.autoTuneScale));
            } catch (e) {
                autoTuneNode = null;
            }
        }

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = settings.compressorEnabled ? -24 : 0;
        compressor.knee.value = 18;
        compressor.ratio.value = settings.compressorEnabled ? 6 : 1;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.15;

        const gateGain = ctx.createGain();
        gateGain.gain.value = isMuted ? 0 : 1;

        const preGateAnalyser = ctx.createAnalyser();
        preGateAnalyser.fftSize = 512;
        preGateAnalyser.smoothingTimeConstant = 0.35;

        const micTestGain = ctx.createGain();
        micTestGain.gain.value = micTestActive ? 1 : 0;

        const dest = ctx.createMediaStreamDestination();

        source.connect(highPass);
        highPass.connect(inputGain);
        if (autoTuneNode) {
            inputGain.connect(autoTuneNode);
            autoTuneNode.connect(compressor);
        } else {
            inputGain.connect(compressor);
        }
        compressor.connect(preGateAnalyser);
        compressor.connect(gateGain);
        gateGain.connect(dest);
        gateGain.connect(micTestGain);
        micTestGain.connect(ctx.destination);

        pipeline = {
            source,
            highPass,
            inputGain,
            autoTuneNode,
            compressor,
            preGateAnalyser,
            gateGain,
            micTestGain,
            dest
        };

        startLevelAndGateLoop();
        processedStream = dest.stream;
        return processedStream;
    }

    function startLevelAndGateLoop() {
        clearInterval(levelTimer);
        if (!pipeline) return;

        const data = new Uint8Array(pipeline.preGateAnalyser.frequencyBinCount);
        let lastSpeaking = false;
        let holdUntil = 0;

        levelTimer = setInterval(() => {
            if (!pipeline) return;
            pipeline.preGateAnalyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            const pct = Math.min(100, Math.round((avg / 65) * 100));

            const meterFill = document.getElementById('mic-level-fill');
            if (meterFill) {
                meterFill.style.width = pct + '%';
            }

            const now = Date.now();
            const threshold = settings.noiseGateThreshold;
            const gateOpen = !isMuted && (threshold === 0 || avg >= threshold);
            if (gateOpen && avg > 2) {
                holdUntil = now + 260;
            }
            const active = !isMuted && (now < holdUntil || (threshold === 0 && avg > 6));

            const targetGain = (!isMuted && (threshold === 0 || now < holdUntil)) ? 1.0 : 0.0;
            pipeline.gateGain.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.025);

            if (active !== lastSpeaking) {
                lastSpeaking = active;
                if (typeof onSpeakingChangeCb === 'function') {
                    onSpeakingChangeCb(active);
                }
            }
        }, 55);
    }

    function teardownPipelineOnly() {
        clearInterval(levelTimer);
        levelTimer = null;
        if (pipeline) {
            try { pipeline.source.disconnect(); } catch (_) {}
            try { pipeline.micTestGain.disconnect(); } catch (_) {}
            pipeline = null;
        }
    }

    async function acquireMicrophone(onSpeakingChange) {
        if (onSpeakingChange) onSpeakingChangeCb = onSpeakingChange;
        if (rawStream) {
            rawStream.getTracks().forEach(t => t.stop());
            rawStream = null;
        }

        const constraints = {
            audio: {
                deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
                noiseSuppression: settings.noiseSuppression,
                echoCancellation: settings.echoCancellation,
                autoGainControl: settings.autoGainControl
            },
            video: false
        };

        rawStream = await navigator.mediaDevices.getUserMedia(constraints);
        return await buildPipeline(rawStream);
    }

    async function refreshMicrophoneForPeers(peerConnections) {
        try {
            const newStream = await acquireMicrophone(onSpeakingChangeCb);
            const newTrack = newStream.getAudioTracks()[0];
            if (newTrack && peerConnections) {
                for (const peer of Object.values(peerConnections)) {
                    const sender = peer.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        await sender.replaceTrack(newTrack);
                    }
                }
            }
            return newStream;
        } catch (e) {
            console.warn('Could not re-acquire microphone:', e);
            return null;
        }
    }

    function applyLiveDspSettings() {
        saveSettings();
        if (!pipeline || !audioCtx) return;
        const now = audioCtx.currentTime;
        pipeline.highPass.frequency.setValueAtTime(settings.highPassEnabled ? 90 : 10, now);
        pipeline.inputGain.gain.setTargetAtTime(settings.gain, now, 0.02);
        pipeline.compressor.threshold.setValueAtTime(settings.compressorEnabled ? -24 : 0, now);
        pipeline.compressor.ratio.setValueAtTime(settings.compressorEnabled ? 6 : 1, now);

        if (pipeline.autoTuneNode) {
            pipeline.autoTuneNode.parameters.get('enabled').setValueAtTime(settings.autoTuneEnabled ? 1 : 0, now);
            pipeline.autoTuneNode.parameters.get('semitones').setValueAtTime(settings.pitchShiftSemitones, now);
            pipeline.autoTuneNode.parameters.get('retuneSpeed').setValueAtTime(settings.retuneSpeed, now);
            pipeline.autoTuneNode.parameters.get('scaleMode').setValueAtTime(Math.max(0, scaleToIndex(settings.autoTuneScale)), now);
        }
    }

    function releaseMicrophone() {
        micTestActive = false;
        updateMicTestButton();
        teardownPipelineOnly();
        if (rawStream) {
            rawStream.getTracks().forEach(t => t.stop());
            rawStream = null;
        }
        processedStream = null;
    }

    function toggleMute() {
        isMuted = !isMuted;
        if (!isMuted && isDeafened) {
            isDeafened = false;
            applyDeafenToRemoteAudio();
        }
        updateQuickButtons();
        return isMuted;
    }

    function toggleDeafen() {
        isDeafened = !isDeafened;
        if (isDeafened) {
            prevMuteBeforeDeafen = isMuted;
            isMuted = true;
        } else {
            isMuted = prevMuteBeforeDeafen;
        }
        applyDeafenToRemoteAudio();
        updateQuickButtons();
        return isDeafened;
    }

    function applyDeafenToRemoteAudio() {
        document.querySelectorAll('audio[id^="audio-"]').forEach(el => {
            el.muted = isDeafened;
            if (!isDeafened && settings.outputDeviceId && typeof el.setSinkId === 'function') {
                el.setSinkId(settings.outputDeviceId).catch(() => {});
            }
        });
    }

    function applyOutputDeviceToElement(audioEl) {
        if (!audioEl) return;
        audioEl.muted = isDeafened;
        if (settings.outputDeviceId && typeof audioEl.setSinkId === 'function') {
            audioEl.setSinkId(settings.outputDeviceId).catch(() => {});
        }
    }

    function updateQuickButtons() {
        const muteBtn = document.getElementById('mute-mic-btn');
        const deafenBtn = document.getElementById('deafen-btn');
        const micLabel = document.getElementById('mic-status-label');

        if (muteBtn) {
            muteBtn.classList.toggle('active-danger', isMuted);
            muteBtn.textContent = isMuted ? '\uD83D\uDD07' : '\uD83C\uDFA4';
            muteBtn.title = isMuted ? 'Unmute Microphone' : 'Mute Microphone';
        }
        if (deafenBtn) {
            deafenBtn.classList.toggle('active-danger', isDeafened);
            deafenBtn.textContent = isDeafened ? '\uD83D\uDD15' : '\uD83C\uDFA7';
            deafenBtn.title = isDeafened ? 'Undeafen' : 'Deafen';
        }
        if (micLabel && processedStream) {
            micLabel.textContent = isDeafened ? 'Deafened' : (isMuted ? 'Muted' : 'Mic Ready');
        }
    }

    function updateMicTestButton() {
        const btn = document.getElementById('mic-test-btn');
        if (btn) {
            btn.textContent = micTestActive ? 'Stop Mic Test' : "Let's Check (Test Mic)";
            btn.classList.toggle('active-danger', micTestActive);
        }
    }

    async function populateDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inSel = document.getElementById('mic-device-select');
            const outSel = document.getElementById('speaker-device-select');
            if (inSel) {
                inSel.innerHTML = '<option value="">Default Microphone</option>';
                devices.filter(d => d.kind === 'audioinput').forEach((d, idx) => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.textContent = d.label || `Microphone ${idx + 1}`;
                    if (d.deviceId === settings.inputDeviceId) opt.selected = true;
                    inSel.appendChild(opt);
                });
            }
            if (outSel) {
                outSel.innerHTML = '<option value="">Default Speaker / Headphones</option>';
                devices.filter(d => d.kind === 'audiooutput').forEach((d, idx) => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.textContent = d.label || `Speaker ${idx + 1}`;
                    if (d.deviceId === settings.outputDeviceId) opt.selected = true;
                    outSel.appendChild(opt);
                });
            }
        } catch (e) {
            console.warn('Device enumeration failed:', e);
        }
    }

    function syncModalInputs() {
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

        setChk('opt-noise-suppression', settings.noiseSuppression);
        setChk('opt-echo-cancellation', settings.echoCancellation);
        setChk('opt-auto-gain', settings.autoGainControl);
        setChk('opt-high-pass', settings.highPassEnabled);
        setChk('opt-compressor', settings.compressorEnabled);
        setChk('opt-autotune', settings.autoTuneEnabled);

        setVal('opt-gain', Math.round(settings.gain * 100));
        setTxt('opt-gain-val', Math.round(settings.gain * 100) + '%');

        setVal('opt-gate', settings.noiseGateThreshold);
        setTxt('opt-gate-val', settings.noiseGateThreshold === 0 ? 'Off' : settings.noiseGateThreshold);

        setVal('opt-autotune-scale', settings.autoTuneScale);
        setVal('opt-pitch-shift', settings.pitchShiftSemitones);
        setTxt('opt-pitch-shift-val', (settings.pitchShiftSemitones > 0 ? '+' : '') + settings.pitchShiftSemitones + ' st');

        setVal('opt-retune-speed', Math.round(settings.retuneSpeed * 100));
        setTxt('opt-retune-speed-val', Math.round(settings.retuneSpeed * 100) + '%');
    }

    function initSettingsUi(getPeersFn) {
        syncModalInputs();

        const bindConstraintToggle = (id, key) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', async () => {
                settings[key] = el.checked;
                saveSettings();
                if (rawStream) await refreshMicrophoneForPeers(getPeersFn());
            });
        };

        bindConstraintToggle('opt-noise-suppression', 'noiseSuppression');
        bindConstraintToggle('opt-echo-cancellation', 'echoCancellation');
        bindConstraintToggle('opt-auto-gain', 'autoGainControl');

        const micSel = document.getElementById('mic-device-select');
        if (micSel) {
            micSel.addEventListener('change', async () => {
                settings.inputDeviceId = micSel.value;
                saveSettings();
                if (rawStream) await refreshMicrophoneForPeers(getPeersFn());
            });
        }

        const spkSel = document.getElementById('speaker-device-select');
        if (spkSel) {
            spkSel.addEventListener('change', () => {
                settings.outputDeviceId = spkSel.value;
                saveSettings();
                applyDeafenToRemoteAudio();
            });
        }

        const gainSlider = document.getElementById('opt-gain');
        if (gainSlider) {
            gainSlider.addEventListener('input', () => {
                settings.gain = Number(gainSlider.value) / 100;
                document.getElementById('opt-gain-val').textContent = gainSlider.value + '%';
                applyLiveDspSettings();
            });
        }

        const gateSlider = document.getElementById('opt-gate');
        if (gateSlider) {
            gateSlider.addEventListener('input', () => {
                settings.noiseGateThreshold = Number(gateSlider.value);
                document.getElementById('opt-gate-val').textContent =
                    settings.noiseGateThreshold === 0 ? 'Off' : settings.noiseGateThreshold;
                saveSettings();
            });
        }

        ['opt-high-pass', 'opt-compressor', 'opt-autotune'].forEach((id, idx) => {
            const keys = ['highPassEnabled', 'compressorEnabled', 'autoTuneEnabled'];
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    settings[keys[idx]] = el.checked;
                    applyLiveDspSettings();
                });
            }
        });

        const scaleSel = document.getElementById('opt-autotune-scale');
        if (scaleSel) {
            scaleSel.addEventListener('change', () => {
                settings.autoTuneScale = scaleSel.value;
                applyLiveDspSettings();
            });
        }

        const pitchSlider = document.getElementById('opt-pitch-shift');
        if (pitchSlider) {
            pitchSlider.addEventListener('input', () => {
                settings.pitchShiftSemitones = Number(pitchSlider.value);
                document.getElementById('opt-pitch-shift-val').textContent =
                    (settings.pitchShiftSemitones > 0 ? '+' : '') + settings.pitchShiftSemitones + ' st';
                applyLiveDspSettings();
            });
        }

        const retuneSlider = document.getElementById('opt-retune-speed');
        if (retuneSlider) {
            retuneSlider.addEventListener('input', () => {
                settings.retuneSpeed = Number(retuneSlider.value) / 100;
                document.getElementById('opt-retune-speed-val').textContent = retuneSlider.value + '%';
                applyLiveDspSettings();
            });
        }

        const testBtn = document.getElementById('mic-test-btn');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                if (!rawStream) {
                    try {
                        await acquireMicrophone(onSpeakingChangeCb);
                    } catch (_) {
                        return;
                    }
                }
                micTestActive = !micTestActive;
                if (pipeline && audioCtx) {
                    pipeline.micTestGain.gain.setTargetAtTime(micTestActive ? 1 : 0, audioCtx.currentTime, 0.02);
                }
                updateMicTestButton();
            });
        }
    }

    async function openSettingsModal() {
        syncModalInputs();
        await populateDevices();
        const modal = document.getElementById('voice-settings-modal');
        if (modal) modal.style.display = 'flex';
    }

    function closeSettingsModal() {
        if (micTestActive) {
            micTestActive = false;
            if (pipeline && audioCtx) {
                pipeline.micTestGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02);
            }
            updateMicTestButton();
        }
        const modal = document.getElementById('voice-settings-modal');
        if (modal) modal.style.display = 'none';
    }

    return {
        acquireMicrophone,
        releaseMicrophone,
        toggleMute,
        toggleDeafen,
        applyOutputDeviceToElement,
        initSettingsUi,
        openSettingsModal,
        closeSettingsModal,
        getProcessedStream: () => processedStream,
        isMuted: () => isMuted,
        isDeafened: () => isDeafened
    };
})();
