/**
 * Voice → text. Abstracted behind one function so the provider is swappable.
 * Default: OpenAI Whisper (whisper-1). Returns transcript text, or null on failure.
 */

export async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[Transcribe] OPENAI_API_KEY not set — voice not supported');
    return null;
  }
  try {
    const ext = mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
      : mimeType.includes('wav') ? 'wav'
      : mimeType.includes('m4a') || mimeType.includes('mp4') ? 'm4a'
      : 'ogg';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.error('[Transcribe] API error', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    return null;
  }
}
