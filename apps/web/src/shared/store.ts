import { serverPayloadSchemas, type GameState } from '@bingo/shared';
import { createStore } from 'zustand/vanilla';
import { z } from 'zod';

type Schemas = typeof serverPayloadSchemas;
export type ServerEvent = keyof Schemas;
type Payload<K extends ServerEvent> = z.infer<Schemas[K]>;
type RoomState = Payload<'room:state'>;
type WalletState = Payload<'wallet:update'>;

export interface SessionState {
  game: GameState | null;
  rooms: Record<string, RoomState>;
  wallet: WalletState | null;
  claim: Payload<'game:claim_result'> | null;
  ended: Payload<'game:ended'> | null;
  serverError: Payload<'error'> | null;
  sequences: Record<string, number>;
  syncing: Record<string, boolean>;
}

export function createSessionStore() {
  const retiredGameIds = new Set<string>();
  const requiredSnapshotSeq = new Map<string, number>();
  const store = createStore<SessionState>(() => ({
    game: null,
    rooms: {},
    wallet: null,
    claim: null,
    ended: null,
    serverError: null,
    sequences: {},
    syncing: {},
  }));

  function ingest<K extends ServerEvent>(event: K, input: unknown): boolean {
    const parsed = serverPayloadSchemas[event].safeParse(input);
    if (!parsed.success) return false;
    const state = store.getState();
    if (event === 'error') {
      store.setState({ serverError: parsed.data as Payload<'error'> });
      return true;
    }
    if (event === 'state:snapshot') {
      const snapshot = parsed.data as Payload<'state:snapshot'>;
      const key = `game:${snapshot.game.gameId}`;
      const last = state.sequences[key];
      if (
        retiredGameIds.has(snapshot.game.gameId) ||
        snapshot.seq !== snapshot.game.seq ||
        snapshot.seq < (requiredSnapshotSeq.get(key) ?? 0) ||
        (last !== undefined &&
          (snapshot.seq < last || (snapshot.seq === last && !state.syncing[key])))
      )
        return false;
      if (state.game && state.game.gameId !== snapshot.game.gameId)
        retiredGameIds.add(state.game.gameId);
      requiredSnapshotSeq.delete(key);
      store.setState({
        game: snapshot.game,
        claim: null,
        ended: null,
        sequences: { ...state.sequences, [key]: snapshot.seq },
        syncing: {
          ...state.syncing,
          ...(state.game ? { [`game:${state.game.gameId}`]: false } : {}),
          [key]: false,
        },
      });
      return true;
    }
    const payload = parsed.data as Exclude<
      Payload<ServerEvent>,
      Payload<'error'> | Payload<'state:snapshot'>
    >;
    const key =
      event === 'room:state'
        ? `room:${(payload as RoomState).room.id}`
        : event === 'wallet:update'
          ? 'wallet'
          : `game:${(payload as Payload<'game:started'>).gameId}`;
    if (key.startsWith('game:') && retiredGameIds.has(key.slice(5))) return false;
    const last = state.sequences[key];
    if (last !== undefined && payload.seq <= last) return false;
    if (
      state.syncing[key] ||
      (last !== undefined && payload.seq !== last + 1) ||
      (last === undefined &&
        key.startsWith('game:') &&
        (event !== 'game:started' || payload.seq !== 1))
    ) {
      requiredSnapshotSeq.set(key, Math.max(requiredSnapshotSeq.get(key) ?? 0, payload.seq));
      store.setState({ syncing: { ...state.syncing, [key]: true } });
      return false;
    }
    const update: Partial<SessionState> = {
      sequences: { ...state.sequences, [key]: payload.seq },
    };
    if (event === 'room:state') {
      const room = payload as RoomState;
      update.rooms = { ...state.rooms, [room.room.id]: room };
    } else if (event === 'wallet:update') {
      update.wallet = payload as WalletState;
    } else if (event === 'game:started') {
      const game = payload as Payload<'game:started'>;
      if (state.game && state.game.gameId !== game.gameId) {
        retiredGameIds.add(state.game.gameId);
        update.syncing = { ...state.syncing, [`game:${state.game.gameId}`]: false };
      }
      update.game = {
        gameId: game.gameId,
        roomId: game.roomId,
        status: 'running',
        seq: game.seq,
        seedHash: game.seedHash,
        calledNumbers: [],
        ...(game.yourCard ? { yourCard: game.yourCard } : {}),
      };
      update.claim = null;
      update.ended = null;
    } else {
      if (!state.game || key !== `game:${state.game.gameId}`) return false;
      if (event === 'game:number') {
        const draw = payload as Payload<'game:number'>;
        if (
          draw.calledNumbers.length !== state.game.calledNumbers.length + 1 ||
          draw.calledNumbers.at(-1) !== draw.number ||
          state.game.calledNumbers.some((number, index) => draw.calledNumbers[index] !== number)
        ) {
          requiredSnapshotSeq.set(key, draw.seq);
          store.setState({ syncing: { ...state.syncing, [key]: true } });
          return false;
        }
        update.game = { ...state.game, calledNumbers: draw.calledNumbers, seq: draw.seq };
      } else if (event === 'game:claim_result') {
        update.claim = payload as Payload<'game:claim_result'>;
        update.game = { ...state.game, seq: payload.seq };
      } else if (event === 'game:ended') {
        update.ended = payload as Payload<'game:ended'>;
        update.game = { ...state.game, status: 'ended', seq: payload.seq };
      }
    }
    store.setState(update);
    return true;
  }
  return { store, ingest };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
