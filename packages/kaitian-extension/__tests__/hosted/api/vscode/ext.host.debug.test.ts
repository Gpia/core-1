import { IRPCProtocol } from '@ali/ide-connection/lib/common/rpcProtocol';
import { MainThreadAPIIdentifier } from '../../../../src/common/vscode';
import { ExtHostCommands } from '../../../../src/hosted/api/vscode/ext.host.command';
import { createBrowserInjector } from '../../../../../debug/node_modules/@ali/ide-dev-tool/src/injector-helper';
import { URI } from '@ali/ide-core-common';
import { ExtHostDebug, createDebugApiFactory } from '@ali/ide-kaitian-extension/lib/hosted/api/vscode/debug';
import { ExtHostConnection } from '@ali/ide-kaitian-extension/lib/hosted/api/vscode/ext.host.connection';
import * as path from 'path';

const mockMainThreadCommandProxy = {
  $executeCommand: jest.fn(() => new Promise(() => ({}))),
  $registerCommand: jest.fn(),
};

const map = new Map();

const rpcProtocol: IRPCProtocol = {
  getProxy: (key) => {
    return map.get(key);
  },
  set: (key, value) => {
    map.set(key, value);
    return value;
  },
  get: (r) => map.get(r),
};

const mockMainThreadDebug = {
  $appendToDebugConsole: jest.fn(),
  $appendLineToDebugConsole: jest.fn(),
  $registerDebuggerContribution: jest.fn(),
  $addBreakpoints: jest.fn(),
  $removeBreakpoints: jest.fn(),
  $startDebugging: jest.fn(),
  $customRequest: jest.fn(),
};

const mockMainThreadConnection = {
  $createConnection: jest.fn(),
  $sendMessage: jest.fn(),
  $deleteConnection: jest.fn(),
  ensureConnection: jest.fn(),
};

describe('packages/kaitian-extension/__tests__/hosted/api/vscode/ext.host.debug.test.ts', () => {
  let extHostDebug: ExtHostDebug;
  let extHostCommands: ExtHostCommands;
  let extHostConnection: ExtHostConnection;

  const injector = createBrowserInjector([]);

  beforeAll(() => {
    rpcProtocol.set(MainThreadAPIIdentifier.MainThreadConnection, mockMainThreadConnection as any);
    rpcProtocol.set(MainThreadAPIIdentifier.MainThreadDebug, mockMainThreadDebug as any);
    rpcProtocol.set(MainThreadAPIIdentifier.MainThreadCommands, mockMainThreadCommandProxy as any);

    extHostCommands = injector.get(ExtHostCommands, [rpcProtocol]);
    extHostConnection = injector.get(ExtHostConnection, [rpcProtocol]);
    extHostDebug = injector.get(ExtHostDebug, [rpcProtocol, extHostConnection, extHostCommands]);
  });

  afterAll(() => {
    injector.disposeAll();
  });

  it('createDebugApiFactory should be work', () => {
    const debugApi = createDebugApiFactory(extHostDebug);
    expect(typeof debugApi.activeDebugConsole).toBe('object');
    expect(debugApi.activeDebugSession).toBeUndefined();
    expect(debugApi.breakpoints).toBeUndefined();
    expect(typeof debugApi.onDidStartDebugSession).toBe('function');
    expect(typeof debugApi.onDidTerminateDebugSession).toBe('function');
    expect(typeof debugApi.onDidChangeActiveDebugSession).toBe('function');
    expect(typeof debugApi.onDidReceiveDebugSessionCustomEvent).toBe('function');
    expect(typeof debugApi.onDidChangeBreakpoints).toBe('function');
    expect(typeof debugApi.registerDebugConfigurationProvider).toBe('function');
    expect(typeof debugApi.registerDebugAdapterDescriptorFactory).toBe('function');
    expect(typeof debugApi.registerDebugAdapterTrackerFactory).toBe('function');
    expect(typeof debugApi.startDebugging).toBe('function');
    expect(typeof debugApi.addBreakpoints).toBe('function');
    expect(typeof debugApi.removeBreakpoints).toBe('function');
    expect(typeof debugApi.asDebugSourceUri).toBe('function');
  });

  it('registerDebuggersContributions method should be work', () => {
    extHostCommands.registerCommand(true, 'extHostDebug.test', (() => ({
      modulePath: path.join(__dirname, 'fork.js'),
    })) as any);
    const contributions = [{
      type: 'node',
      adapterExecutableCommand: 'extHostDebug.test',
    }];
    extHostDebug.registerDebuggersContributions(URI.file('home/extension/test').toString(), contributions);
    expect(mockMainThreadDebug.$registerDebuggerContribution).toBeCalledTimes(1);
    mockMainThreadDebug.$registerDebuggerContribution.mockClear();
  });

  it('addBreakpoints method should be work', () => {
    const breakpoints = [{
      id: '1',
      enabled: true,
    }];
    extHostDebug.addBreakpoints(breakpoints);
    expect(mockMainThreadDebug.$addBreakpoints).toBeCalledTimes(1);
    mockMainThreadDebug.$addBreakpoints.mockClear();
  });

  it('removeBreakpoints method should be work', () => {
    const breakpoints = [{
      id: '1',
      enabled: true,
    }];
    extHostDebug.removeBreakpoints(breakpoints);
    expect(mockMainThreadDebug.$removeBreakpoints).toBeCalledTimes(1);
    mockMainThreadDebug.$removeBreakpoints.mockClear();
  });

  it('asDebugSourceUri method should be work', () => {
    const source = {
      sourceReference: 1,
      path: '/file/a.js',
    } as any;
    const session = {
      id: 2,
    } as any;
    // 当有传入session的情况
    expect(extHostDebug.asDebugSourceUri(source, session).toString()).toBe(`debug:/file/a.js?${encodeURIComponent(`session=${session.id}&ref=${source.sourceReference}`)}`);
    // 不传入session的情况
    expect(extHostDebug.asDebugSourceUri(source).toString()).toBe(`debug:/file/a.js?${encodeURIComponent(`ref=${source.sourceReference}`)}`);

    const localSource = {
      path: '/file/b.js',
    } as any;
    expect(extHostDebug.asDebugSourceUri(localSource).toString()).toBe(`file:///file/b.js`);
  });

  it('startDebugging method should be work', () => {
    extHostDebug.startDebugging(undefined, 'test');
    expect(mockMainThreadDebug.$startDebugging).toBeCalledTimes(1);
    mockMainThreadDebug.$startDebugging.mockClear();
  });

  it('registerDebugConfigurationProvider method should be work', () => {
    expect(typeof extHostDebug.registerDebugConfigurationProvider('debug', {}).dispose).toBe('function');
  });

  it('registerDebugAdapterDescriptorFactory method should be work', () => {
    expect(typeof extHostDebug.registerDebugAdapterDescriptorFactory('debug', {
      createDebugAdapterDescriptor: (() => {}) as any,
    }).dispose).toBe('function');
  });

  it('registerDebugAdapterTrackerFactory method should be work', () => {
    expect(typeof extHostDebug.registerDebugAdapterTrackerFactory('debug', {
      createDebugAdapterTracker: (() => {}) as any,
    }).dispose).toBe('function');
  });

  it('RPC methods all should be work', async (done) => {
    const sessionId = await extHostDebug.$createDebugSession({
      type: 'node',
      name: 'test',
      request: '',
    });
    expect(mockMainThreadConnection.$createConnection).toBeCalledTimes(1);
    await extHostDebug.$onSessionCustomEvent(sessionId, 'event');
    await extHostDebug.$sessionDidStart(sessionId);
    await extHostDebug.$sessionDidDestroy(sessionId);
    await extHostDebug.$sessionDidChange(sessionId);
    await extHostDebug.$breakpointsDidChange([], [], [], []);
    extHostDebug.onDidTerminateDebugSession(() => {
      done();
    });
    await extHostDebug.$terminateDebugSession(sessionId);
  });
});