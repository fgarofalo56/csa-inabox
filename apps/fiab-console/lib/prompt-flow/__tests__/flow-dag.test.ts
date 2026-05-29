/**
 * Contract tests for the flow.dag.yaml model: parse, serialize, round-trip,
 * and graph derivation.
 *
 * Per .claude/rules/no-vaporware.md these are real backend-style tests in the
 * `node` vitest env (no DOM). They lock the flow.dag.yaml shape the editor
 * round-trips to Foundry's prompt-flow REST.
 */
import { describe, it, expect } from 'vitest';
import {
  parseFlowDag, serializeFlowDag, flowToGraph, starterFlow, emptyFlow,
  referencedNodes, referencesFlowInputs, INPUTS_NODE, OUTPUTS_NODE,
  type FlowDag,
} from '../flow-dag';

const WEB_CLASSIFICATION = `inputs:
  url:
    type: string
    default: https://www.bing.com
outputs:
  category:
    type: string
    reference: \${classify.output.category}
  evidence:
    type: string
    reference: \${classify.output.evidence}
nodes:
- name: fetch_text
  type: python
  source:
    type: code
    path: fetch_text.py
  inputs:
    url: \${inputs.url}
- name: summarize
  type: llm
  source:
    type: code
    path: summarize.jinja2
  inputs:
    text: \${fetch_text.output}
    max_tokens: 256
  connection: aoai-conn
  api: chat
  deployment_name: gpt-4o
  provider: AzureOpenAI
  module: promptflow.tools.aoai
- name: classify
  type: python
  source:
    type: code
    path: classify.py
  inputs:
    summary: \${summarize.output}
    url: \${inputs.url}
`;

describe('parseFlowDag', () => {
  it('parses inputs with type + default', () => {
    const dag = parseFlowDag(WEB_CLASSIFICATION);
    expect(dag.inputs).toEqual([{ name: 'url', type: 'string', default: 'https://www.bing.com' }]);
  });

  it('parses outputs with reference', () => {
    const dag = parseFlowDag(WEB_CLASSIFICATION);
    expect(dag.outputs).toEqual([
      { name: 'category', type: 'string', reference: '${classify.output.category}' },
      { name: 'evidence', type: 'string', reference: '${classify.output.evidence}' },
    ]);
  });

  it('parses nodes with type, source, inputs, and llm config', () => {
    const dag = parseFlowDag(WEB_CLASSIFICATION);
    expect(dag.nodes.map((n) => n.name)).toEqual(['fetch_text', 'summarize', 'classify']);
    const llm = dag.nodes.find((n) => n.name === 'summarize')!;
    expect(llm.type).toBe('llm');
    expect(llm.connection).toBe('aoai-conn');
    expect(llm.api).toBe('chat');
    expect(llm.deploymentName).toBe('gpt-4o');
    expect(llm.source).toMatchObject({ type: 'code', path: 'summarize.jinja2' });
    expect(llm.inputs).toMatchObject({ text: '${fetch_text.output}', max_tokens: 256 });
  });

  it('tolerates empty / missing sections', () => {
    expect(parseFlowDag('inputs: {}\noutputs: {}\nnodes: []\n')).toEqual({ inputs: [], outputs: [], nodes: [] });
    expect(parseFlowDag('')).toEqual({ inputs: [], outputs: [], nodes: [] });
  });

  it('preserves a literal block-scalar code body on a node source', () => {
    const yaml = `inputs: {}
outputs: {}
nodes:
- name: greet
  type: python
  source:
    type: code
    code: |-
      from promptflow import tool
      @tool
      def my(x: str) -> str:
          return 'hi ' + x
  inputs:
    x: \${inputs.name}
`;
    const dag = parseFlowDag(yaml);
    expect(dag.nodes[0].source?.code).toContain('@tool');
    expect(dag.nodes[0].source?.code).toContain("return 'hi ' + x");
  });
});

describe('serializeFlowDag + round-trip', () => {
  it('round-trips the web-classification flow without losing structure', () => {
    const dag = parseFlowDag(WEB_CLASSIFICATION);
    const yaml = serializeFlowDag(dag);
    const dag2 = parseFlowDag(yaml);
    expect(dag2).toEqual(dag);
  });

  it('round-trips the starter flow (llm node with jinja2 block-scalar prompt)', () => {
    const dag = starterFlow();
    const yaml = serializeFlowDag(dag);
    expect(yaml).toContain('type: llm');
    expect(yaml).toContain('reference: ${answer.output}');
    const dag2 = parseFlowDag(yaml);
    // connection '' is dropped on serialize (honest gate fills it), so compare
    // with the connection normalized away.
    const norm = (d: FlowDag) => ({
      ...d,
      nodes: d.nodes.map((n) => ({ ...n, connection: n.connection || undefined, deploymentName: n.deploymentName || undefined })),
    });
    expect(norm(dag2)).toEqual(norm(dag));
  });

  it('emits valid empty sections for an empty flow', () => {
    const yaml = serializeFlowDag(emptyFlow());
    expect(yaml).toContain('inputs: {}');
    expect(yaml).toContain('outputs: {}');
    expect(yaml).toContain('nodes: []');
  });
});

describe('reference helpers', () => {
  it('extracts referenced node names from ${node.output(.field)}', () => {
    expect(referencedNodes('${summarize.output}')).toEqual(['summarize']);
    expect(referencedNodes('${classify.output.category}')).toEqual(['classify']);
    expect(referencedNodes({ a: '${n1.output}', b: ['${n2.output.x}'] }).sort()).toEqual(['n1', 'n2']);
  });

  it('detects flow-input references', () => {
    expect(referencesFlowInputs('${inputs.url}')).toBe(true);
    expect(referencesFlowInputs('${input.url}')).toBe(true);
    expect(referencesFlowInputs('${summarize.output}')).toBe(false);
  });
});

describe('flowToGraph', () => {
  it('derives Inputs/Outputs nodes + edges from references', () => {
    const dag = parseFlowDag(WEB_CLASSIFICATION);
    const { nodes, edges } = flowToGraph(dag);
    expect(nodes[0].id).toBe(INPUTS_NODE);
    expect(nodes[nodes.length - 1].id).toBe(OUTPUTS_NODE);
    expect(nodes.map((n) => n.id)).toContain('summarize');

    const has = (from: string, to: string) => edges.some((e) => e.from === from && e.to === to);
    expect(has(INPUTS_NODE, 'fetch_text')).toBe(true);   // ${inputs.url}
    expect(has('fetch_text', 'summarize')).toBe(true);   // ${fetch_text.output}
    expect(has('summarize', 'classify')).toBe(true);     // ${summarize.output}
    expect(has(INPUTS_NODE, 'classify')).toBe(true);     // ${inputs.url}
    expect(has('classify', OUTPUTS_NODE)).toBe(true);    // output references classify
  });

  it('does not duplicate edges when a node references another twice', () => {
    const dag: FlowDag = {
      inputs: [{ name: 'x', type: 'string' }],
      outputs: [],
      nodes: [
        { name: 'a', type: 'python', inputs: { x: '${inputs.x}' } },
        { name: 'b', type: 'python', inputs: { p: '${a.output}', q: '${a.output.y}' } },
      ],
    };
    const { edges } = flowToGraph(dag);
    expect(edges.filter((e) => e.from === 'a' && e.to === 'b').length).toBe(1);
  });
});
