import { useEffect, useState } from 'react';

import { AI_MODEL_BASE } from '../ai/ai-worker-protocol';

// "AI Play" runs the built-in AI (src/modules/ai) entirely in the browser. It
// needs the model files in public/ai; this checks once whether they are there.

export type AiModelAvailability = 'checking' | 'available' | 'missing';

export function useAiModelAvailability() {
  const [availability, setAvailability] = useState<AiModelAvailability>('checking');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${AI_MODEL_BASE}/model.onnx`, { method: 'HEAD', cache: 'no-cache', signal: controller.signal })
      .then((response) => {
        setAvailability(response.ok ? 'available' : 'missing');
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailability('missing');
      });
    return () => {
      controller.abort();
    };
  }, []);
  return availability;
}
