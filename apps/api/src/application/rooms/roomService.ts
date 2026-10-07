import { AppError, ErrorCode } from '@bingo/shared';
import type { Room } from '../../domain/entities.js';
import type { RoomRepository } from '../../domain/repositories.js';

export class RoomService {
  constructor(private readonly rooms: RoomRepository) {}

  async listOpenRooms(): Promise<Room[]> {
    return this.rooms.listOpen();
  }

  async getRoom(roomId: string): Promise<Room> {
    const room = await this.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    return room;
  }
}
