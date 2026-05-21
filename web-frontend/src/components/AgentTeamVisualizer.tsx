/**
 * AgentTeamVisualizer — animated SVG tree of the configured team.
 *
 * Shows the lead model on top, fanning down to each worker slot via
 * curved lines. Provider colour is derived per node. Cross-fades when
 * the model on a slot changes (keyed by index + model so swapping the
 * model on slot 2 retriggers the fade).
 *
 * Pure CSS / SVG. No canvas, no extra deps. Honors prefers-reduced-motion
 * via `.module.css`.
 */

import type { JSX } from 'react';
import { useMemo } from 'react';

import type { AgentsWorkerSlotWire } from '../../../src/web/protocol/rest-types.js';

import styles from './AgentTeamVisualizer.module.css';

/**
 * Brand colour mapping. Names are lowercased on lookup. The fallback
 * "neutral" tone keeps the visualizer readable for unknown models.
 */
export type ProviderKey =
  | 'deepseek'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'qwen'
  | 'mistral'
  | 'meta'
  | 'ollama'
  | 'lmstudio'
  | 'unknown';

export function providerForModel(model: string): ProviderKey {
  const m = model.toLowerCase();
  if (m.startsWith('deepseek') || m.includes('/deepseek')) return 'deepseek';
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.includes('openai')) {
    return 'openai';
  }
  if (m.startsWith('gemini') || m.includes('google/')) return 'google';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('mistral') || m.includes('codestral')) return 'mistral';
  if (m.includes('llama')) return 'meta';
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.includes('lmstudio')) return 'lmstudio';
  if (m.includes('ollama')) return 'ollama';
  return 'unknown';
}

export function providerColor(p: ProviderKey): string {
  switch (p) {
    case 'deepseek':
      return '#14b8a6';
    case 'anthropic':
      return '#f97316';
    case 'openai':
      return '#10b981';
    case 'google':
      return '#3b82f6';
    case 'openrouter':
      return '#8b5cf6';
    case 'qwen':
      return '#a855f7';
    case 'mistral':
      return '#ef4444';
    case 'meta':
      return '#0ea5e9';
    case 'ollama':
      return '#64748b';
    case 'lmstudio':
      return '#6b7280';
    case 'unknown':
    default:
      return '#7a5cff';
  }
}

export function providerLabel(p: ProviderKey): string {
  switch (p) {
    case 'deepseek':
      return 'DeepSeek';
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'google':
      return 'Google';
    case 'openrouter':
      return 'OpenRouter';
    case 'qwen':
      return 'Qwen';
    case 'mistral':
      return 'Mistral';
    case 'meta':
      return 'Meta';
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'unknown':
    default:
      return 'Custom';
  }
}

export interface AgentTeamVisualizerProps {
  leadModel: string | null;
  /** Falls back to "active model" hint when leadModel is null. */
  activeModel: string | null;
  workerSlots: AgentsWorkerSlotWire[];
  maxConcurrent: number;
}

const NODE_R = 28;
const TOP_Y = 44;
const BOTTOM_Y = 168;
const VIEW_H = 220;

function abbreviate(model: string): string {
  if (model.length === 0) return '·';
  // Strip provider prefix and pick first 3 alpha chars.
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  const cleaned = tail.replace(/[^a-zA-Z0-9]/g, '');
  if (cleaned.length === 0) return tail.slice(0, 3).toUpperCase();
  return cleaned.slice(0, 3).toUpperCase();
}

interface NodeView {
  key: string;
  cx: number;
  cy: number;
  label: string;
  color: string;
  providerName: string;
  fullModel: string;
  faded: boolean;
}

export function AgentTeamVisualizer(props: AgentTeamVisualizerProps): JSX.Element {
  const { leadModel, activeModel, workerSlots, maxConcurrent } = props;

  const effectiveLead = leadModel ?? activeModel ?? '';
  const slotCount = workerSlots.length;

  const { width, leadNode, workerNodes } = useMemo(() => {
    // Lay out workers evenly across an adaptive viewBox.
    const minWidth = 360;
    const perSlot = 84;
    const w = Math.max(minWidth, slotCount * perSlot + 80);
    const cx = w / 2;
    const lead: NodeView = {
      key: 'lead',
      cx,
      cy: TOP_Y,
      label: abbreviate(effectiveLead),
      color: providerColor(providerForModel(effectiveLead)),
      providerName: providerLabel(providerForModel(effectiveLead)),
      fullModel: effectiveLead.length > 0 ? effectiveLead : 'Active model',
      faded: false,
    };
    if (slotCount === 0) {
      return { width: w, leadNode: lead, workerNodes: [] as NodeView[] };
    }
    const margin = 56;
    const usable = w - margin * 2;
    const step = slotCount === 1 ? 0 : usable / (slotCount - 1);
    const startX = slotCount === 1 ? cx : margin;
    const workers: NodeView[] = workerSlots.map((s, i) => {
      const provider = providerForModel(s.model);
      const xPos = startX + step * i;
      return {
        key: `slot-${i}-${s.model}`,
        cx: xPos,
        cy: BOTTOM_Y,
        label: abbreviate(s.model),
        color: providerColor(provider),
        providerName: providerLabel(provider),
        fullModel: s.model,
        faded: i >= maxConcurrent,
      };
    });
    return { width: w, leadNode: lead, workerNodes: workers };
  }, [effectiveLead, workerSlots, slotCount, maxConcurrent]);

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${width} ${VIEW_H}`}
        className={styles.svg}
        role="img"
        aria-label="Team visualization"
      >
        {/* Connectors */}
        <g className={styles.connectors}>
          {workerNodes.map((n) => {
            const dx = n.cx - leadNode.cx;
            const midY = (TOP_Y + BOTTOM_Y) / 2;
            const d = `M ${leadNode.cx} ${TOP_Y + NODE_R} C ${leadNode.cx} ${midY}, ${leadNode.cx + dx} ${midY}, ${n.cx} ${BOTTOM_Y - NODE_R}`;
            return (
              <path
                key={n.key + '-edge'}
                d={d}
                className={`${styles.edge} ${n.faded ? styles.edgeFaded : ''}`}
                stroke={n.color}
              />
            );
          })}
        </g>

        {/* Lead node */}
        <g key={`lead-${effectiveLead}`} className={styles.nodeGroup}>
          <circle
            cx={leadNode.cx}
            cy={leadNode.cy}
            r={NODE_R + 6}
            className={styles.haloLead}
            style={{ stroke: leadNode.color }}
          />
          <circle
            cx={leadNode.cx}
            cy={leadNode.cy}
            r={NODE_R}
            className={styles.node}
            style={{ fill: leadNode.color }}
          />
          <text
            x={leadNode.cx}
            y={leadNode.cy + 4}
            textAnchor="middle"
            className={styles.nodeLabel}
          >
            {leadNode.label}
          </text>
          <text
            x={leadNode.cx}
            y={leadNode.cy - NODE_R - 10}
            textAnchor="middle"
            className={styles.cap}
          >
            LEAD
          </text>
        </g>

        {/* Worker nodes */}
        {workerNodes.map((n, i) => (
          <g key={n.key} className={`${styles.nodeGroup} ${n.faded ? styles.fadedGroup : ''}`}>
            <circle
              cx={n.cx}
              cy={n.cy}
              r={NODE_R}
              className={styles.node}
              style={{ fill: n.color }}
            />
            <text
              x={n.cx}
              y={n.cy + 4}
              textAnchor="middle"
              className={styles.nodeLabel}
            >
              {n.label}
            </text>
            <text
              x={n.cx}
              y={n.cy + NODE_R + 16}
              textAnchor="middle"
              className={styles.cap}
            >
              {`AGENT ${i + 1}`}
            </text>
            {n.faded ? (
              <text
                x={n.cx}
                y={n.cy + NODE_R + 30}
                textAnchor="middle"
                className={styles.queueHint}
              >
                wait queue
              </text>
            ) : null}
          </g>
        ))}

        {workerNodes.length === 0 ? (
          <text
            x={width / 2}
            y={BOTTOM_Y}
            textAnchor="middle"
            className={styles.emptyHint}
          >
            No worker agents — add a slot to build your team
          </text>
        ) : null}
      </svg>
    </div>
  );
}
