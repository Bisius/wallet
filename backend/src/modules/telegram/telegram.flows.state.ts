/**
 * The state of the conversations in progress (docs/DOMAIN.md, "Flow state"): in memory, ONE flow per
 * chat, keyed by chat id, with a 15-minute timeout counted from its last step. A restart loses only
 * a flow in progress, and nothing has been written until its last step.
 *
 * Each flow has a short random id, which the `callback_data` of its buttons carries, so a button of
 * a flow that ended, was replaced or expired is told apart from the current one. The id is random
 * (not a counter), so that a stale button from before a restart can never match a new flow.
 */
import type { Cents, IsoDate } from '@wallet/shared';
import { randomInt } from 'node:crypto';
import type { Clock } from '../../lib/clock';

/** A flow expires this long after its last step. */
export const FLOW_TIMEOUT_MS = 15 * 60 * 1000;

export type FlowKind = 'spending' | 'quick' | 'income';

/**
 * Where the flow waits. `amount` and `note` wait for TEXT (the note step of an income asks for its
 * description); `budget`, `date`, `earlier` and `closed` wait for a BUTTON.
 */
export type FlowStep = 'budget' | 'amount' | 'note' | 'date' | 'earlier' | 'closed';

export interface Flow {
  id: string;
  kind: FlowKind;
  chatId: number;
  step: FlowStep;
  /** `Clock` time (ms) of the last step; the timeout counts from it. */
  touchedAt: number;
  /** The message that holds the current prompt, so its keyboard can be removed when the flow moves on. */
  promptMessageId: number | undefined;
  budgetId?: number;
  /** Signed cents. */
  amount?: Cents;
  /** The note of a spending, or the description of an income. */
  note?: string;
  /** The date being confirmed in the closed-month question. */
  date?: IsoDate;
}

export const waitsForText = (flow: Flow): boolean => flow.step === 'amount' || flow.step === 'note';

/**
 * Whether the message that holds the flow's prompt has a keyboard: every button step does, and so
 * does the note step of a spending (Skip). The amount step and an income's description step ask for
 * text with no buttons, so there is no keyboard to take away.
 */
export const promptHasKeyboard = (flow: Flow): boolean =>
  !waitsForText(flow) || (flow.step === 'note' && flow.kind === 'spending');

export interface FlowStore {
  /** The live flow of the chat. An expired one is dropped and reads as none. */
  get(chatId: number): Flow | undefined;
  /** Starts `flow` in its chat, replacing the one in progress. */
  put(flow: Flow): void;
  /** Takes the flow out (it ended or was cancelled). */
  delete(chatId: number): void;
  /** Counts a step: the timeout starts again. */
  touch(flow: Flow): void;
  /** A fresh id for a new flow. */
  newId(): string;
}

/** A random id of 5 base-36 characters (60 million of them), at most 8 are read back. */
export const randomFlowId = (): string =>
  randomInt(36 ** 5)
    .toString(36)
    .padStart(5, '0');

export function createFlowStore(clock: Clock, makeId: () => string = randomFlowId): FlowStore {
  const flows = new Map<number, Flow>();
  return {
    get(chatId) {
      const flow = flows.get(chatId);
      if (flow && clock.now().getTime() - flow.touchedAt >= FLOW_TIMEOUT_MS) {
        flows.delete(chatId);
        return undefined;
      }
      return flow;
    },
    put(flow) {
      flows.set(flow.chatId, flow);
    },
    delete(chatId) {
      flows.delete(chatId);
    },
    touch(flow) {
      flow.touchedAt = clock.now().getTime();
    },
    newId: makeId,
  };
}
