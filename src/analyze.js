/**
 * Image / PDF analysis via Claude Vision — turns media into a text description
 * that can be embedded as a first-class idea node. (Adapted from reminder-bot.)
 */

export async function analyzeImage(imageBuffer, mimeType, prompt) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const base64 = imageBuffer.toString('base64');
    const mediaType = mimeType?.includes('png') ? 'image/png'
      : mimeType?.includes('webp') ? 'image/webp'
      : mimeType?.includes('gif') ? 'image/gif'
      : 'image/jpeg';

    const userPrompt = prompt || 'Describe this image as a single concise idea/note for a personal knowledge graph. Capture the key subject, concepts, and any text shown. 1-3 sentences, no preamble.';

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: userPrompt },
        ],
      }],
    });
    return response.content[0]?.text?.trim() || 'Could not analyze the image.';
  } catch (err) {
    console.error('[Analyze] Error:', err.message);
    return null;
  }
}

export async function analyzePdfBuffer(pdfBuffer, prompt) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const base64 = pdfBuffer.toString('base64');
    const userPrompt = prompt || 'Summarize this document as a concise idea/note for a personal knowledge graph: the core topic and key points. 2-4 sentences, no preamble.';

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: userPrompt },
        ],
      }],
    });
    return response.content[0]?.text?.trim() || 'Could not analyze the PDF.';
  } catch (err) {
    console.error('[Analyze PDF] Error:', err.message);
    return null;
  }
}
