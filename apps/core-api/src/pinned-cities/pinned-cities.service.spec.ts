import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { PinnedCitiesService } from './pinned-cities.service';
import { API_LIMITS } from '../meta/limits';

type PrismaMock = {
  pinnedCity: {
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    deleteMany: jest.Mock;
  };
};

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'p1',
  userId: 'u1',
  name: 'Berlin',
  country: 'DE',
  admin1: null,
  latitude: 52.52,
  longitude: 13.405,
  order: 0,
  createdAt: new Date(),
  ...over,
});

const dto = {
  name: 'Berlin',
  country: 'DE',
  latitude: 52.52,
  longitude: 13.405,
};

describe('PinnedCitiesService', () => {
  let service: PinnedCitiesService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      pinnedCity: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(row()),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PinnedCitiesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PinnedCitiesService);
  });

  describe('findAll', () => {
    it('scopes the query to the caller', async () => {
      await service.findAll('u1');

      const [args] = prisma.pinnedCity.findMany.mock.calls[0] as [
        { where: { userId: string } },
      ];
      expect(args.where).toEqual({ userId: 'u1' });
    });

    it('orders by the explicit order first, falling back to age', async () => {
      await service.findAll('u1');

      const [args] = prisma.pinnedCity.findMany.mock.calls[0] as [
        { orderBy: unknown },
      ];
      // Rows written before `order` existed all share a value, so createdAt is
      // what keeps their sequence stable rather than leaving it to the planner.
      expect(args.orderBy).toEqual([{ order: 'asc' }, { createdAt: 'asc' }]);
    });
  });

  describe('create', () => {
    it('refuses once the per-user limit is reached', async () => {
      prisma.pinnedCity.count.mockResolvedValue(API_LIMITS.maxPinnedCities);

      await expect(service.create('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.pinnedCity.create).not.toHaveBeenCalled();
    });

    it('allows the last slot under the limit', async () => {
      prisma.pinnedCity.count.mockResolvedValue(API_LIMITS.maxPinnedCities - 1);

      await expect(service.create('u1', dto)).resolves.toMatchObject({
        name: 'Berlin',
      });
    });

    it('appends at the end rather than colliding on an existing position', async () => {
      prisma.pinnedCity.count.mockResolvedValue(3);

      await service.create('u1', dto);

      const [args] = prisma.pinnedCity.create.mock.calls[0] as [
        { data: { order: number; userId: string } },
      ];
      expect(args.data.order).toBe(3);
      expect(args.data.userId).toBe('u1');
    });

    it('normalises absent optional fields to null rather than undefined', async () => {
      await service.create('u1', {
        name: 'Berlin',
        latitude: 52.52,
        longitude: 13.405,
      });

      const [args] = prisma.pinnedCity.create.mock.calls[0] as [
        { data: { country: string | null; admin1: string | null } },
      ];
      expect(args.data.country).toBeNull();
      expect(args.data.admin1).toBeNull();
    });

    it('turns the unique-constraint violation into a 400, not a 500', async () => {
      prisma.pinnedCity.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      // The pin already exists, which is the user's mistake to see rather than
      // ours to leak as an unhandled database error.
      await expect(service.create('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('lets an unrelated database failure through untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('nope', {
        code: 'P2003',
        clientVersion: 'test',
      });
      prisma.pinnedCity.create.mockRejectedValue(failure);

      // Only P2002 means "already pinned"; swallowing the rest would report a
      // broken database as a validation problem.
      await expect(service.create('u1', dto)).rejects.toBe(failure);
    });
  });

  describe('remove', () => {
    it('deletes only rows the caller owns', async () => {
      await service.remove('u1', 'p1');

      expect(prisma.pinnedCity.deleteMany).toHaveBeenCalledWith({
        where: { id: 'p1', userId: 'u1' },
      });
    });

    it('is idempotent for an id that is gone or was never theirs', async () => {
      prisma.pinnedCity.deleteMany.mockResolvedValue({ count: 0 });

      // deleteMany scoped by userId is also the authorisation check: another
      // user's id matches nothing, and answering 404 would confirm it exists.
      await expect(service.remove('u1', 'someone-elses')).resolves.toEqual({
        id: 'someone-elses',
      });
    });
  });
});
