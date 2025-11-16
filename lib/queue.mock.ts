import type { QueueClient } from 'oci-queue';
import * as requests from 'oci-queue/lib/request';

interface MockMessage {
  id: string;
  receipt: string;
  content: string;
  metadata?: {
    channelId?: string;
    customProperties?: Record<string, string>;
  };
  visibleAt: number;
}

export class MockQueueClient implements Pick<QueueClient, 'getMessages' | 'putMessages' | 'deleteMessage'> {
  private messages: Map<string, MockMessage[]> = new Map();
  private receipts: Map<string, string> = new Map();
  private messageIndex: Map<string, Map<string, number>> = new Map();
  private receiptCounter = 0;
  private messageIdCounter = 0;

  constructor() {}

  async getMessages(request: requests.GetMessagesRequest): Promise<any> {
    const queueId = request.queueId || '';
    const limit = request.limit || 10;
    const visibilityInSeconds = request.visibilityInSeconds || 30;
    const now = Date.now();

    const queueMessages = this.messages.get(queueId) || [];

    const visibleMessages = queueMessages.filter((msg) => msg.visibleAt <= now).slice(0, limit);

    const messagesWithReceipts = visibleMessages.map((msg) => {
      const receipt = `local-receipt-${this.receiptCounter++}`;
      this.receipts.set(receipt, msg.id);

      msg.visibleAt = now + visibilityInSeconds * 1000;
      msg.receipt = receipt;

      return {
        id: msg.id,
        receipt: msg.receipt,
        content: msg.content,
        metadata: msg.metadata,
      };
    });

    return {
      getMessages: {
        messages: messagesWithReceipts,
      },
    };
  }

  async putMessages(request: requests.PutMessagesRequest): Promise<any> {
    const queueId = request.queueId || '';
    const messages = request.putMessagesDetails?.messages || [];

    if (!queueId) {
      throw new Error('Queue ID is required');
    }

    if (!this.messages.has(queueId)) {
      this.messages.set(queueId, []);
    }

    const queueMessages = this.messages.get(queueId);
    if (!queueMessages) {
      return { entries: [] };
    }

    const entries: Array<{ id: string; receipt: string }> = [];
    const now = Date.now();

    let queueIndex = this.messageIndex.get(queueId);
    if (!queueIndex) {
      queueIndex = new Map();
      this.messageIndex.set(queueId, queueIndex);
    }

    messages.forEach((msg) => {
      const messageId = `local-msg-${now}-${this.messageIdCounter++}`;
      const mockMessage: MockMessage = {
        id: messageId,
        receipt: '',
        content: msg.content || '',
        metadata: msg.metadata,
        visibleAt: now,
      };

      const index = queueMessages.length;
      queueMessages.push(mockMessage);
      queueIndex.set(messageId, index);

      entries.push({
        id: messageId,
        receipt: `local-put-receipt-${this.receiptCounter++}`,
      });
    });

    return {
      entries,
    };
  }

  async deleteMessage(request: requests.DeleteMessageRequest): Promise<any> {
    const queueId = request.queueId || '';
    const receipt = request.messageReceipt || '';

    if (!queueId || !receipt) {
      return {};
    }

    const messageId = this.receipts.get(receipt);
    if (messageId) {
      const queueMessages = this.messages.get(queueId);
      const queueIndex = this.messageIndex.get(queueId);
      if (queueMessages && queueIndex) {
        const index = queueIndex.get(messageId);
        if (index !== undefined && index < queueMessages.length && queueMessages[index].id === messageId) {
          const lastIndex = queueMessages.length - 1;
          if (index !== lastIndex) {
            const lastMessage = queueMessages[lastIndex];
            queueMessages[index] = lastMessage;
            queueIndex.set(lastMessage.id, index);
          }
          queueMessages.pop();
          queueIndex.delete(messageId);
        }
      }
      this.receipts.delete(receipt);
    }

    return {};
  }

  clearQueue(queueId: string): void {
    const queueMessages = this.messages.get(queueId) || [];
    queueMessages.forEach((msg) => {
      if (msg.receipt) {
        this.receipts.delete(msg.receipt);
      }
    });
    this.messages.delete(queueId);
    this.messageIndex.delete(queueId);
  }

  clearAllQueues(): void {
    this.messages.clear();
    this.receipts.clear();
    this.messageIndex.clear();
  }

  getMessageCount(queueId: string): number {
    return this.messages.get(queueId)?.length || 0;
  }

  getAllMessages(queueId: string): MockMessage[] {
    return [...(this.messages.get(queueId) || [])];
  }

  queueExists(queueId: string): boolean {
    return this.messages.has(queueId);
  }
}
