import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { MetadataScanner, ModuleRef, ModulesContainer, Reflector } from '@nestjs/core';
import { QUEUE_OPTIONS } from './queue.constants';
import { QueueService } from './queue.service';
import { QueueModuleAsyncOptions, QueueModuleOptionsFactory, QueueOptions } from './queue.types';

@Module({})
export class QueueModule {
  public static register(options: QueueOptions): DynamicModule {
    const queueOptions: Provider = {
      provide: QUEUE_OPTIONS,
      useValue: options,
    };
    const queueProvider: Provider = {
      provide: QueueService,
      useClass: QueueService,
    };

    return {
      module: QueueModule,
      imports: [],
      providers: [queueOptions, queueProvider, Reflector, ModulesContainer, MetadataScanner],
      exports: [queueProvider],
      global: true,
    };
  }

  public static registerAsync(options: QueueModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    const queueProvider: Provider = {
      provide: QueueService,
      useClass: QueueService,
    };

    return {
      module: QueueModule,
      imports: [...(options.imports ?? [])],
      providers: [...asyncProviders, queueProvider, Reflector, ModulesContainer, MetadataScanner],
      exports: [queueProvider],
      global: true,
    };
  }

  private static createAsyncProviders(options: QueueModuleAsyncOptions): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<QueueModuleOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(options: QueueModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: QUEUE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    const inject = [(options.useClass || options.useExisting) as Type<QueueModuleOptionsFactory>];
    return {
      provide: QUEUE_OPTIONS,
      useFactory: async (optionsFactory: QueueModuleOptionsFactory) => await optionsFactory.createOptions(),
      inject,
    };
  }
}
