import { BadRequestException, Injectable } from '@nestjs/common';
import { PinnedCity, Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { CreatePinnedCityDto } from './dto/create-pinned-city.dto';

const MAX_PINNED_PER_USER = 12;

@Injectable()
export class PinnedCitiesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(userId: string): Promise<PinnedCity[]> {
    return this.prisma.pinnedCity.findMany({
      where: { userId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: string, dto: CreatePinnedCityDto): Promise<PinnedCity> {
    const count = await this.prisma.pinnedCity.count({ where: { userId } });
    if (count >= MAX_PINNED_PER_USER) {
      throw new BadRequestException(
        `Pinned city limit reached (max ${MAX_PINNED_PER_USER})`,
      );
    }
    try {
      return await this.prisma.pinnedCity.create({
        data: {
          userId,
          name: dto.name,
          country: dto.country ?? null,
          admin1: dto.admin1 ?? null,
          latitude: dto.latitude,
          longitude: dto.longitude,
          order: count,
        },
      });
    } catch (err) {
      // Unique [userId, lat, lon] — the city is already pinned.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException('City is already pinned');
      }
      throw err;
    }
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.prisma.pinnedCity.deleteMany({ where: { id, userId } });
    return { id };
  }
}
