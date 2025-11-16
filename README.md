# @batatahub/nestjs-oci-queue

[![Test](https://github.com/batatahub/nestjs-oci-queue/workflows/Test/badge.svg)](https://github.com/batatahub/nestjs-oci-queue/actions?query=workflow%3ATest)
[![npm version](https://badge.fury.io/js/%40batatahub%2Fnestjs-oci-queue.svg)](https://badge.fury.io/js/%40batatahub%2Fnestjs-oci-queue)

A powerful NestJS module for seamless integration with **Oracle Cloud Infrastructure (OCI) Queue**. Built with TypeScript and designed for modern NestJS applications, this module provides a decorator-based approach to handle queue messages with minimal configuration.

## Features

- 🎯 **Decorator-based message handling** - Simple and intuitive API
- 🔄 **Automatic message polling** - Background consumers with configurable intervals
- 📦 **Batch processing support** - Handle multiple messages efficiently
- 🧪 **Built-in mock mode** - Test locally without OCI credentials
- ⚡ **Type-safe** - Full TypeScript support with proper types
- 🛡️ **Error handling** - Built-in error events and retry mechanisms
- 🔌 **NestJS native** - Seamless integration with NestJS dependency injection

## Installation

```bash
npm install @batatahub/nestjs-oci-queue oci-queue oci-common
```

Or with pnpm:

```bash
pnpm add @batatahub/nestjs-oci-queue oci-queue oci-common
```

## Prerequisites

- Node.js >= 18.0.0
- NestJS >= 6.10.11
- OCI Queue OCID (not URL) - format: `ocid1.queue.oc1.region.unique_id`
- OCI credentials configured (or use local mode for development)

## Quick Start

### 1. Configure OCI Credentials

For production, ensure your OCI credentials are configured:

```bash
# Default location: ~/.oci/config
# Or set OCI_CONFIG_FILE environment variable
```

### 2. Register the Module

```typescript
import { Module } from '@nestjs/common';
import { QueueModule } from '@batatahub/nestjs-oci-queue';

@Module({
  imports: [
    QueueModule.register({
      consumers: [
        {
          name: 'orderProcessor',
          queueId: 'ocid1.queue.oc1.sa-saopaulo-1.amaaaaaa...',
          pollingInterval: 1000, // milliseconds
          visibilityTimeoutInSeconds: 30,
          timeoutInSeconds: 30,
          maxMessages: 10,
        },
      ],
      producers: [
        {
          name: 'orderProducer',
          queueId: 'ocid1.queue.oc1.sa-saopaulo-1.amaaaaaa...',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

### 3. Create Message Handlers

```typescript
import { Injectable } from '@nestjs/common';
import {
  QueueMessageHandler,
  QueueConsumerEventHandler,
  OciQueueReceivedMessage,
} from '@batatahub/nestjs-oci-queue';

@Injectable()
export class OrderHandler {
  @QueueMessageHandler('orderProcessor', false)
  async processOrder(message: OciQueueReceivedMessage) {
    const orderData = JSON.parse(message.content);
    console.log('Processing order:', orderData);
    // Your business logic here
  }

  @QueueConsumerEventHandler('orderProcessor', 'processing_error')
  onProcessingError(error: Error, message: OciQueueReceivedMessage) {
    console.error('Failed to process order:', error);
    // Error reporting logic
  }
}
```

### 4. Send Messages

```typescript
import { Injectable } from '@nestjs/common';
import { QueueService, Message } from '@batatahub/nestjs-oci-queue';

@Injectable()
export class OrderService {
  constructor(private readonly queueService: QueueService) {}

  async createOrder(orderData: any) {
    await this.queueService.send('orderProducer', {
      body: orderData,
      metadata: {
        channelId: 'orders',
        customProperties: {
          source: 'api',
          version: '1.0',
        },
      },
    });
  }
}
```

## Local Development Mode

Develop and test without OCI credentials using the built-in mock mode:

### Option 1: Environment Variable (Recommended)

```bash
export OCI_QUEUE_LOCAL_MODE=true
npm run start:dev
```

### Option 2: Module Configuration

```typescript
QueueModule.register({
  localMode: true,
  consumers: [...],
  producers: [...],
})
```

**Benefits of local mode:**
- ✅ No OCI credentials required
- ✅ Works offline
- ✅ No costs
- ✅ Full control over queue behavior
- ✅ Same API as production

## Advanced Configuration

### Async Module Registration

Use `registerAsync()` for dynamic configuration:

```typescript
import { ConfigModule, ConfigService } from '@nestjs/config';

QueueModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (configService: ConfigService) => ({
    consumers: [
      {
        name: 'orderProcessor',
        queueId: configService.get('OCI_QUEUE_ID'),
        pollingInterval: configService.get('POLLING_INTERVAL', 1000),
      },
    ],
    producers: [
      {
        name: 'orderProducer',
        queueId: configService.get('OCI_QUEUE_ID'),
      },
    ],
  }),
  inject: [ConfigService],
})
```

### Batch Processing

Handle multiple messages at once:

```typescript
@Injectable()
export class BatchOrderHandler {
  @QueueMessageHandler('orderProcessor', true) // batch: true
  async processBatch(messages: OciQueueReceivedMessage[]) {
    for (const message of messages) {
      const orderData = JSON.parse(message.content);
      await this.processOrder(orderData);
    }
  }
}
```

### Custom Profiles and Regions

```typescript
QueueModule.register({
  profile: 'PRODUCTION',
  region: 'us-ashburn-1',
  consumers: [
    {
      name: 'orderProcessor',
      queueId: 'ocid1.queue...',
      profile: 'PRODUCTION', // Override global profile
      region: 'us-ashburn-1', // Override global region
    },
  ],
})
```

### Error Handling Events

Subscribe to different consumer events:

```typescript
@Injectable()
export class OrderHandler {
  @QueueConsumerEventHandler('orderProcessor', 'error')
  onError(error: Error) {
    // Handle polling errors
  }

  @QueueConsumerEventHandler('orderProcessor', 'processing_error')
  onProcessingError(error: Error, message: OciQueueReceivedMessage) {
    // Handle message processing errors
  }
}
```

## Configuration Options

### QueueOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `consumers` | `OciQueueConsumerOptions[]` | No | Array of consumer configurations |
| `producers` | `OciQueueProducerOptions[]` | No | Array of producer configurations |
| `localMode` | `boolean` | No | Enable mock mode for local development |
| `profile` | `string` | No | OCI profile name (default: 'DEFAULT') |
| `region` | `string` | No | OCI region |
| `endpoint` | `string` | No | Custom OCI endpoint |
| `logger` | `LoggerService` | No | Custom logger instance |

### OciQueueConsumerOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique consumer identifier |
| `queueId` | `string` | Yes | OCI Queue OCID |
| `pollingInterval` | `number` | No | Polling interval in ms (default: 1000) |
| `visibilityTimeoutInSeconds` | `number` | No | Message visibility timeout (default: 30) |
| `timeoutInSeconds` | `number` | No | Request timeout (default: 30) |
| `maxMessages` | `number` | No | Max messages per poll (default: 10) |
| `stopOnError` | `boolean` | No | Stop consumer on error (default: false) |
| `profile` | `string` | No | Override global profile |
| `region` | `string` | No | Override global region |
| `endpoint` | `string` | No | Override global endpoint |

### OciQueueProducerOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique producer identifier |
| `queueId` | `string` | Yes | OCI Queue OCID |
| `profile` | `string` | No | Override global profile |
| `region` | `string` | No | Override global region |
| `endpoint` | `string` | No | Override global endpoint |

## Type Definitions

For complete type definitions, see [queue.types.ts](./lib/queue.types.ts).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the [MIT License](./LICENSE).

## Related Projects

- [OCI Queue Documentation](https://docs.oracle.com/en-us/iaas/Content/queue/overview.htm)
- [NestJS Documentation](https://docs.nestjs.com/)
