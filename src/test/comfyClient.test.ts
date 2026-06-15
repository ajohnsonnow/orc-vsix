import { describe, it, expect } from 'vitest';
import { applyWorkflowTemplate, PROMPT_TOKEN } from '../comfy/comfyClient.js';

describe('applyWorkflowTemplate', () => {
  const baseWorkflow = JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: `${PROMPT_TOKEN}, masterpiece`, clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: 12345, steps: 20 } },
  });

  it('injects the prompt into the placeholder field', () => {
    const graph = applyWorkflowTemplate(baseWorkflow, 'a red fox');
    expect(graph['6'].inputs!.text).toBe('a red fox, masterpiece');
  });

  it('randomizes the seed so runs differ', () => {
    const graph = applyWorkflowTemplate(baseWorkflow, 'x');
    expect(graph['3'].inputs!.seed).not.toBe(12345);
    expect(typeof graph['3'].inputs!.seed).toBe('number');
  });

  it('randomizes noise_seed as well', () => {
    const wf = JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: PROMPT_TOKEN } },
      '2': { class_type: 'SamplerCustom', inputs: { noise_seed: 999 } },
    });
    const graph = applyWorkflowTemplate(wf, 'cat');
    expect(graph['2'].inputs!.noise_seed).not.toBe(999);
  });

  it('throws if the placeholder is missing (prompt would be ignored)', () => {
    const wf = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'static' } } });
    expect(() => applyWorkflowTemplate(wf, 'hello')).toThrow(/ORC_PROMPT/);
  });

  it('replaces every occurrence of the placeholder', () => {
    const wf = JSON.stringify({
      '6': { class_type: 'CLIPTextEncode', inputs: { text: PROMPT_TOKEN } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: `style of ${PROMPT_TOKEN}` } },
    });
    const graph = applyWorkflowTemplate(wf, 'neon city');
    expect(graph['6'].inputs!.text).toBe('neon city');
    expect(graph['7'].inputs!.text).toBe('style of neon city');
  });
});
