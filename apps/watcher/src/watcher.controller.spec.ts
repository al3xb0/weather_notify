import { Test, TestingModule } from '@nestjs/testing';
import { WatcherController } from './watcher.controller';
import { WatcherService } from './watcher.service';

describe('WatcherController', () => {
  let watcherController: WatcherController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [WatcherController],
      providers: [WatcherService],
    }).compile();

    watcherController = app.get<WatcherController>(WatcherController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(watcherController.getHello()).toBe('Hello World!');
    });
  });
});
