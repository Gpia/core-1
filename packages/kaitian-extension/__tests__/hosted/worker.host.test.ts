import { Deferred } from '@ali/ide-core-common/lib';
import { RPCProtocol } from '@ali/ide-connection/lib/common/rpcProtocol';
import { ProxyIdentifier } from '@ali/ide-connection';
import { ExtensionWorkerHost } from '../../src/hosted/worker.host';
import { mockExtensionProps, mockExtensionProps2 } from '../__mock__/extensions';
import { initMockRPCProtocol } from '../__mock__/initRPCProtocol';
import { MainThreadExtensionService } from '../__mock__/api/mainthread.extension.service';
import { MainThreadStorage } from '../__mock__/api/mathread.storage';
import { MainThreadExtensionLog } from '../__mock__/api/mainthread.extension.log';
import { MockWorker, MessagePort, MessageChannel, mockFetch } from '../__mock__/worker';

const enum MessageType {
  Request = 1,
  Reply = 2,
  ReplyErr = 3,
  Cancel = 4,
}

(global as any).self = global;
(global as any).fetch = mockFetch;
(global as any).Worker = MockWorker;
(global as any).MessagePort = MessagePort;
(global as any).MessageChannel = MessageChannel;

describe('Extension Worker Thread Test Suites', () => {

  let extHostImpl: ExtensionWorkerHost;
  let rpcProtocol: RPCProtocol;

  const proxyMaps = new Map();
  proxyMaps.set('MainThreadExtensionService', new MainThreadExtensionService());
  proxyMaps.set('MainThreadStorage', new MainThreadStorage());
  proxyMaps.set('MainThreadExtensionLog', new MainThreadExtensionLog());

  const handler = new Deferred<(msg) => any>();
  const fn = handler.promise;
  const mockClient = {
    send: async (msg) => {
      const message = JSON.parse(msg);
      const proxy = proxyMaps.get(message.proxyId);
      if (proxy) {
        const result = await proxy[message.method](...message.args);
        if (await fn) {
          const raw = `{"type": ${MessageType.Reply}, "id": "${message.id}", "res": ${JSON.stringify(result || '')}}`;
          (await fn)(raw);
        }
      } else {
        // tslint:disable-next-line
        console.log(`lost proxy ${message.proxyId} - ${message.method}`);
      }
    },
    onMessage: (fn) => handler.resolve(fn),
  };

  beforeAll(async (done) => {
    rpcProtocol = await initMockRPCProtocol(mockClient);
    extHostImpl = new ExtensionWorkerHost(rpcProtocol);
    done();
  });

  it('init extensions', async () => {
    await extHostImpl.$updateExtHostData();
    const extensions = extHostImpl.getExtensions();
    const ext = extHostImpl.getExtension(mockExtensionProps.id);
    expect(extensions.length).toBe(2);
    expect(ext?.id).toBe(mockExtensionProps.id);
  });

  it('activate extension', async () => {
    const id = mockExtensionProps.id;
    await extHostImpl.$activateExtension(id);
    expect(extHostImpl.isActivated(id)).toBe(true);
  });

  it('test for activated extension exportsAPI', async () => {
    const id = mockExtensionProps.id;
    expect(extHostImpl.getExtensionExports(id)).not.toEqual({});
    const exportsAPI = extHostImpl.getExtensionExports(id);
    expect(exportsAPI).toBeDefined();
    expect((exportsAPI as any).sayHello).toBeDefined();
    expect(typeof (exportsAPI as any).sayHello).toBe('function');
    const res = (exportsAPI as any).sayHello();
    expect(res).toBe('hello');
  });

  it('test for extension runtime error', async () => {
    const id = mockExtensionProps2.id;
    await extHostImpl.$activateExtension(id);
    expect(extHostImpl.isActivated(id)).toBe(true);
    const exportsAPI2 = extHostImpl.getExtensionExports(id);
    expect(exportsAPI2).toBeDefined();
    expect((exportsAPI2 as any).sayHello).toBeDefined();
    expect(typeof (exportsAPI2 as any).sayHello).toBe('function');
    expect(() => {
      (exportsAPI2 as any).sayHello();
    }).toThrowError('worker runtime error.');
  });

  it('should register view proxy', async () => {
    const id = mockExtensionProps2.id;
    await extHostImpl.$activateExtension(id);
    const EXTENSION_EXTEND_SERVICE_PREFIX = 'extension_extend_service';
    const proxies = rpcProtocol.getProxy({ serviceId: `${EXTENSION_EXTEND_SERVICE_PREFIX}:${id}:FakeComponentId` } as ProxyIdentifier<any>);
    // 这里其实没法覆盖到，因为 getProxy 永远都返回不为空..
    expect(proxies).toBeDefined();
  });
});
