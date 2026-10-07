import type { z } from 'zod';
import type { clientPayloadSchemas, serverPayloadSchemas } from './schemas/socket.js';

export type ClientEventName = keyof typeof clientPayloadSchemas;
export type ServerEventName = keyof typeof serverPayloadSchemas;
export type ClientPayloads = { [K in ClientEventName]: z.infer<(typeof clientPayloadSchemas)[K]> };
export type ServerPayloads = { [K in ServerEventName]: z.infer<(typeof serverPayloadSchemas)[K]> };
export interface ClientToServerEvents {
  'room:join': (payload: ClientPayloads['room:join']) => void;
  'room:leave': (payload: ClientPayloads['room:leave']) => void;
  'card:select': (payload: ClientPayloads['card:select']) => void;
  'card:release': (payload: ClientPayloads['card:release']) => void;
  'game:ready': (payload: ClientPayloads['game:ready']) => void;
  'game:claim': (payload: ClientPayloads['game:claim']) => void;
  'state:resync': (payload: ClientPayloads['state:resync']) => void;
}
export interface ServerToClientEvents {
  'room:state': (payload: ServerPayloads['room:state']) => void;
  'game:started': (payload: ServerPayloads['game:started']) => void;
  'game:starting': (payload: ServerPayloads['game:starting']) => void;
  'game:number': (payload: ServerPayloads['game:number']) => void;
  'game:claim_result': (payload: ServerPayloads['game:claim_result']) => void;
  'game:ended': (payload: ServerPayloads['game:ended']) => void;
  'wallet:update': (payload: ServerPayloads['wallet:update']) => void;
  'state:snapshot': (payload: ServerPayloads['state:snapshot']) => void;
  error: (payload: ServerPayloads['error']) => void;
}
