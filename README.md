# nestjs-oci-queue

Tested with: [Oracle Cloud](https://www.oracle.com/br/cloud).

Nestjs-oci-queue is a project to make OCI Queue easier to use and control some required flows with NestJS.
This module provides decorator-based message handling suited for simple use.

## Installation

```shell script
npm i --save @batatahub/nestjs-oci-queue oci-queue oci-common
```

## Quick Start

### Local Development Mode

```bash
OCI_QUEUE_LOCAL_MODE=true
```

For local development and testing, you can use the built-in mock mode that simulates OCI Queue locally.

**Option 1: Via Environment Variable (Recommended)**
```bash
npm run start:dev
```

**Option 2: Via Module Configuration**
```ts
QueueModule.register({
  localMode: true, // Enable local mock mode
  consumers: [...],
  producers: [...],
})
```

When `localMode` is enabled, the library uses `MockQueueClient` instead of the real OCI QueueClient. This allows you to:
- Develop and test locally without OCI credentials
- Work offline
- Have full control over queue behavior
- Test without costs

The mock mode is transparent - your code works exactly the same way as in production!

### Register module

```ts
@Module({
  imports: [
    QueueModule.register({
      consumers: [
        {
          name: "myConsumer1",
          queueId: "ocid1.queue.oc1.region.unique_id",
          pollingInterval: 1000,
          visibilityTimeoutInSeconds: 30,
          timeoutInSeconds: 30,
          maxMessages: 10,
        },
      ],
      producers: [
        {
          name: "myProducer1",
          queueId: "ocid1.queue.oc1.region.unique_id",
        },
      ],
      localMode: process.env.OCI_QUEUE_LOCAL_MODE === 'true',
    }),
  ],
})
class AppModule {}
```

Quite often you might want to asynchronously pass module options instead of passing them beforehand.
In such case, use `registerAsync()` method like many other Nest.js libraries.

- Use factory

```ts
QueueModule.registerAsync({
  useFactory: () => {
    return {
      consumers: [...],
      producers: [...],
    };
  },
});
```

- Use class

```ts
QueueModule.registerAsync({
  useClass: QueueConfigService,
});
```

- Use existing

```ts
QueueModule.registerAsync({
  imports: [ConfigModule],
  useExisting: ConfigService,
});
```

### Decorate methods

You need to decorate methods in your NestJS providers in order to have them be automatically attached as event handlers for incoming OCI Queue messages:

```ts
import { OciQueueReceivedMessage } from "@batatahub/nestjs-oci-queue";

@Injectable()
export class AppMessageHandler {
  @QueueMessageHandler(/** name: */ "myConsumer1", /** batch: */ false)
  public async handleMessage(message: OciQueueReceivedMessage) {}

  @QueueConsumerEventHandler(
    /** name: */ "myConsumer1",
    /** eventName: */ "processing_error",
  )
  public onProcessingError(error: Error, message: OciQueueReceivedMessage) {
    // report errors here
  }
}
```

### Produce messages

```ts
import { QueueService, Message } from "@batatahub/nestjs-oci-queue";

export class AppService {
  public constructor(
    private readonly queueService: QueueService,
  ) { }

  public async dispatchSomething() {
    await this.queueService.send(/** name: */ 'myProducer1', {
      body: { ... },
      metadata: {
        channelId: 'default',
        customProperties: { ... },
      },
    });
  }
}
```

### Configuration

See [here](https://github.com/batatahub/nestjs-oci-queue/blob/master/lib/queue.types.ts) for available configuration options.
In most cases you just need to specify both `name` and `queueId` (OCID) at the minimum requirements.

## License

This project is licensed under the terms of the MIT license.
