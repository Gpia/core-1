import os from 'os';
import paths from 'path';

import fileType from 'file-type';
import * as fse from 'fs-extra';
import trash from 'trash';
import writeFileAtomic from 'write-file-atomic';

import { Injectable, INJECTOR_TOKEN, Autowired, Injector } from '@opensumi/di';
import { RPCService } from '@opensumi/ide-connection';
import { Deferred, ILogService, ILogServiceManager, SupportLogNamespace } from '@opensumi/ide-core-node';
import {
  isLinux,
  UriComponents,
  Uri,
  Event,
  IDisposable,
  URI,
  Emitter,
  isUndefined,
  DisposableCollection,
  FileUri,
  uuid,
} from '@opensumi/ide-core-node';
import { Path } from '@opensumi/ide-utils/lib/path';

import {
  FileChangeEvent,
  FileStat,
  FileType,
  DidFilesChangedParams,
  FileSystemError,
  FileMoveOptions,
  isErrnoException,
  notEmpty,
  IDiskFileProvider,
  FileAccess,
  FileSystemProviderCapabilities,
  EXT_LIST_VIDEO,
  EXT_LIST_IMAGE,
} from '../common/';

import { ParcelWatcherServer } from './file-service-watcher';

const UNSUPPORTED_NODE_MODULES_EXCLUDE = '**/node_modules/*/**';
const DEFAULT_NODE_MODULES_EXCLUDE = '**/node_modules/**';

export interface IRPCDiskFileSystemProvider {
  onDidFilesChanged(event: DidFilesChangedParams): void;
}

export interface IWatcher {
  id: number;
  options?: {
    excludes?: string[];
  };
  disposable: IDisposable;
}

@Injectable({ multiple: true })
export class DiskFileSystemProvider extends RPCService<IRPCDiskFileSystemProvider> implements IDiskFileProvider {
  private fileChangeEmitter = new Emitter<FileChangeEvent>();
  private watcherServer: ParcelWatcherServer;
  readonly onDidChangeFile: Event<FileChangeEvent> = this.fileChangeEmitter.event;
  protected watcherServerDisposeCollection: DisposableCollection;

  protected readonly watcherCollection = new Map<string, IWatcher>();
  protected watchFileExcludes: string[] = [];

  private _whenReadyDeferred: Deferred<void> = new Deferred();
  private isInitialized = false;

  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(ILogServiceManager)
  private readonly loggerManager: ILogServiceManager;

  private logger: ILogService;

  constructor() {
    super();
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
    this.initWatchServer();
  }

  get whenReady() {
    return this._whenReadyDeferred.promise;
  }

  onDidChangeCapabilities: Event<void> = Event.None;

  protected _capabilities: FileSystemProviderCapabilities | undefined;
  get capabilities(): FileSystemProviderCapabilities {
    if (!this._capabilities) {
      this._capabilities =
        FileSystemProviderCapabilities.FileReadWrite |
        FileSystemProviderCapabilities.FileOpenReadWriteClose |
        FileSystemProviderCapabilities.FileReadStream |
        FileSystemProviderCapabilities.FileFolderCopy |
        FileSystemProviderCapabilities.FileWriteUnlock;

      if (isLinux) {
        this._capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
      }
    }

    return this._capabilities;
  }

  dispose(): void {
    this.watcherServerDisposeCollection?.dispose();
  }

  /**
   * @param {Uri} uri
   * @param {{ excludes: string[] }}
   * @memberof DiskFileSystemProvider
   */
  async watch(uri: UriComponents, options?: { excludes?: string[] }): Promise<number> {
    await this.whenReady;
    const _uri = Uri.revive(uri);
    const id = await this.watcherServer.watchFileChanges(_uri.toString(), {
      excludes: options?.excludes ?? [],
    });
    const disposable = {
      dispose: () => {
        this.watcherServer.unwatchFileChanges(id);
      },
    };
    this.watcherCollection.set(_uri.toString(), { id, options, disposable });
    return id;
  }

  unwatch(watcherId: number) {
    for (const [_uri, { id, disposable }] of this.watcherCollection) {
      if (watcherId === id) {
        disposable.dispose();
      }
    }
  }

  async stat(uri: UriComponents) {
    const _uri = Uri.revive(uri);
    try {
      const stat = await this.doGetStat(_uri, 1);
      return stat;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async readDirectory(uri: UriComponents): Promise<[string, FileType][]> {
    const _uri = Uri.revive(uri);
    const result: [string, FileType][] = [];
    try {
      const dirList = await fse.readdir(_uri.fsPath);

      dirList.forEach((name) => {
        const filePath = paths.join(_uri.fsPath, name);
        result.push([name, this.getFileStatType(fse.statSync(filePath))]);
      });
      return result;
    } catch (e) {
      return result;
    }
  }

  async createDirectory(uri: UriComponents): Promise<FileStat> {
    const _uri = Uri.revive(uri);
    const stat = await this.doGetStat(_uri, 0);
    if (stat) {
      if (stat.isDirectory) {
        return stat;
      }
      throw FileSystemError.FileExists(uri.path, 'Error occurred while creating the directory: path is a file.');
    }
    await fse.ensureDir(FileUri.fsPath(new URI(_uri)));
    const newStat = await this.doGetStat(_uri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.FileNotFound(uri.path, 'Error occurred while creating the directory.');
  }

  async readFile(uri: UriComponents, encoding = 'utf8'): Promise<Uint8Array> {
    const _uri = Uri.revive(uri);

    try {
      const buffer = await fse.readFile(FileUri.fsPath(new URI(_uri)));
      return buffer;
    } catch (error) {
      if (isErrnoException(error)) {
        if (error.code === 'ENOENT') {
          throw FileSystemError.FileNotFound(uri.path, 'Error occurred while reading file');
        }

        if (error.code === 'EISDIR') {
          throw FileSystemError.FileIsDirectory(uri.path, 'Error occurred while reading file: path is a directory.');
        }

        if (error.code === 'EPERM') {
          throw FileSystemError.FileIsNoPermissions(
            uri.path,
            'Error occurred while reading file: path is a directory.',
          );
        }
      }

      throw error;
    }
  }

  async writeFile(
    uri: UriComponents,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean; encoding?: string },
  ): Promise<void | FileStat> {
    const _uri = Uri.revive(uri);
    const exists = await this.access(uri);

    if (exists && !options.overwrite) {
      throw FileSystemError.FileExists(_uri.toString());
    } else if (!exists && !options.create) {
      throw FileSystemError.FileNotFound(_uri.toString());
    }
    // fileServiceNode调用不会转换，前传通信会转换
    const buffer = content instanceof Buffer ? content : Buffer.from(Uint8Array.from(content));
    if (options.create) {
      return await this.createFile(uri, { content: buffer });
    }

    try {
      await writeFileAtomic(FileUri.fsPath(new URI(_uri)), buffer);
    } catch (e) {
      this.logger.warn('writeFileAtomicSync 出错，使用 fs', e);
      await fse.writeFile(FileUri.fsPath(new URI(_uri)), buffer);
    }
  }

  access(uri: UriComponents, mode: number = FileAccess.Constants.F_OK): Promise<boolean> {
    return fse
      .access(FileUri.fsPath(URI.from(uri)), mode)
      .then(() => true)
      .catch(() => false);
  }

  async delete(uri: UriComponents, options: { recursive?: boolean; moveToTrash?: boolean }): Promise<void> {
    const _uri = Uri.revive(uri);
    const stat = await this.doGetStat(_uri, 0);
    if (!stat) {
      throw FileSystemError.FileNotFound(uri.path);
    }
    if (!isUndefined(options.recursive)) {
      this.logger.warn('DiskFileSystemProvider not support options.recursive!');
    }
    // Windows 10.
    // Deleting an empty directory throws `EPERM error` instead of `unlinkDir`.
    // https://github.com/paulmillr/chokidar/issues/566
    // Force moveToTrash
    const moveToTrash = !!options.moveToTrash;
    if (moveToTrash) {
      return trash([FileUri.fsPath(new URI(_uri))]);
    } else {
      const filePath = FileUri.fsPath(new URI(_uri));
      const outputRootPath = paths.join(os.tmpdir(), uuid());
      try {
        await new Promise<void>((resolve, reject) => {
          fse.rename(filePath, outputRootPath, async (error) => {
            if (error) {
              return reject(error);
            }
            resolve();
          });
        });
        // There is no reason for the promise returned by this function not to resolve
        // as soon as the move is complete.  Clearing up the temporary files can be
        // done in the background.
        fse.remove(FileUri.fsPath(outputRootPath));
      } catch (error) {
        return fse.remove(filePath);
      }
    }
  }

  async rename(sourceUri: UriComponents, targetUri: UriComponents, options: { overwrite: boolean }): Promise<FileStat> {
    const result = await this.doMove(sourceUri, targetUri, options);
    return result;
  }

  async copy(
    sourceUri: UriComponents,
    targetUri: UriComponents,
    options: { overwrite: boolean; recursive?: boolean },
  ): Promise<FileStat> {
    const _sourceUri = Uri.revive(sourceUri);
    const _targetUri = Uri.revive(targetUri);
    const [sourceStat, targetStat] = await Promise.all([this.doGetStat(_sourceUri, 0), this.doGetStat(_targetUri, 0)]);
    const { overwrite, recursive } = options;

    if (!sourceStat) {
      throw FileSystemError.FileNotFound(sourceUri.path);
    }
    if (targetStat && !overwrite) {
      throw FileSystemError.FileExists(targetUri.path, "Did you set the 'overwrite' flag to true?");
    }
    if (targetStat && targetStat.uri === sourceStat.uri) {
      throw FileSystemError.FileExists(targetUri.path, 'Cannot perform copy, source and destination are the same.');
    }
    await fse.copy(FileUri.fsPath(_sourceUri.toString()), FileUri.fsPath(_targetUri.toString()), {
      overwrite,
      recursive,
    });
    const newStat = await this.doGetStat(_targetUri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.FileNotFound(targetUri.path, `Error occurred while copying ${sourceUri} to ${targetUri}.`);
  }

  async getCurrentUserHome(): Promise<FileStat | undefined> {
    return this.stat(FileUri.create(os.homedir()).codeUri);
  }

  // 出于通信成本的考虑，排除文件的逻辑必须放在node层（fs provider层，不同的fs实现的exclude应该不一样）
  setWatchFileExcludes(excludes: string[]) {
    let watchExcludes = excludes;
    if (excludes.includes(UNSUPPORTED_NODE_MODULES_EXCLUDE)) {
      const idx = watchExcludes.findIndex((v) => v === UNSUPPORTED_NODE_MODULES_EXCLUDE);
      watchExcludes = watchExcludes.splice(idx, 1, DEFAULT_NODE_MODULES_EXCLUDE);
    }
    // 每次调用之后都需要重新初始化 WatcherServer，保证最新的规则生效
    this.logger.log('Set watcher exclude:', watchExcludes);
    this.watchFileExcludes = watchExcludes;
    this.initWatchServer(this.watchFileExcludes);
  }

  getWatchFileExcludes() {
    return this.watchFileExcludes;
  }

  getWatchExcludes(excludes?: string[]): string[] {
    return Array.from(new Set(this.watchFileExcludes.concat(excludes || [])));
  }

  protected initWatchServer(excludes?: string[]) {
    if (!this.injector) {
      return;
    }
    if (this.watcherServerDisposeCollection) {
      this.watcherServerDisposeCollection.dispose();
    }
    this.watcherServerDisposeCollection = new DisposableCollection();
    this.watcherServer = this.injector.get(ParcelWatcherServer, [excludes]);
    this.watcherServer.setClient({
      onDidFilesChanged: (events: DidFilesChangedParams) => {
        if (events.changes.length > 0) {
          this.fileChangeEmitter.fire(events.changes);
          if (Array.isArray(this.rpcClient)) {
            this.rpcClient.forEach((client) => {
              client.onDidFilesChanged({
                changes: events.changes,
              });
            });
          }
        }
      },
    });
    this.watcherServerDisposeCollection.push({
      dispose: () => {
        this.watcherServer.dispose();
      },
    });
    if (this.isInitialized) {
      // 当服务已经初始化一次后，重新初始化时需要重新绑定原有的监听服务
      this.rewatch();
    } else {
      this._whenReadyDeferred.resolve();
    }
    this.isInitialized = true;
  }

  private async rewatch() {
    let tasks: {
      id: number;
      uri: string;
      options?: { excludes?: string[] };
    }[] = [];
    for (const [uri, { id, options }] of this.watcherCollection) {
      tasks.push({
        id,
        uri,
        options,
      });
    }
    // 需要针对缓存根据路径深度排序，防止过度监听
    tasks = tasks.sort((a, b) => Path.pathDepth(a.uri) - Path.pathDepth(b.uri));
    for (const { uri, options } of tasks) {
      await this.watch(Uri.parse(uri), { excludes: this.getWatchExcludes(options?.excludes) });
    }
  }

  protected async createFile(uri: UriComponents, options: { content: Buffer }): Promise<FileStat> {
    const _uri = Uri.revive(uri);
    const parentUri = new URI(_uri).parent;
    const parentStat = await this.doGetStat(parentUri.codeUri, 0);
    if (!parentStat) {
      await fse.ensureDir(FileUri.fsPath(parentUri));
    }
    await fse.writeFile(FileUri.fsPath(_uri.toString()), options.content);
    const newStat = await this.doGetStat(_uri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.FileNotFound(uri.path, 'Error occurred while creating the file.');
  }

  /**
   * Return `true` if it's possible for this URI to have children.
   * It might not be possible to be certain because of permission problems or other filesystem errors.
   */
  protected async mayHaveChildren(uri: Uri): Promise<boolean> {
    /* If there's a problem reading the root directory. Assume it's not empty to avoid overwriting anything.  */
    try {
      const rootStat = await this.doGetStat(uri, 0);
      if (rootStat === undefined) {
        return true;
      }
      /* Not a directory.  */
      if (rootStat !== undefined && rootStat.isDirectory === false) {
        return false;
      }
    } catch (error) {
      return true;
    }

    /* If there's a problem with it's children then the directory must not be empty.  */
    try {
      const stat = await this.doGetStat(uri, 1);
      if (stat !== undefined && stat.children !== undefined) {
        return stat.children.length > 0;
      } else {
        return true;
      }
    } catch (error) {
      return true;
    }
  }

  protected async doMove(
    sourceUri: UriComponents,
    targetUri: UriComponents,
    options: FileMoveOptions,
  ): Promise<FileStat> {
    const _sourceUri = Uri.revive(sourceUri);
    const _targetUri = Uri.revive(targetUri);
    const [sourceStat, targetStat] = await Promise.all([this.doGetStat(_sourceUri, 1), this.doGetStat(_targetUri, 1)]);
    const isCapitalizedEqual = _sourceUri.toString().toLocaleUpperCase() === _targetUri.toString().toLocaleUpperCase();
    const { overwrite } = options;
    if (!sourceStat) {
      throw FileSystemError.FileNotFound(sourceUri.path);
    }
    if (targetStat && !overwrite) {
      throw FileSystemError.FileExists(targetUri.path, "Did you set the 'overwrite' flag to true?");
    }

    // Different types. Files <-> Directory.
    if (targetStat && sourceStat.isDirectory !== targetStat.isDirectory) {
      if (targetStat.isDirectory) {
        throw FileSystemError.FileIsDirectory(
          targetStat.uri,
          `Cannot move '${sourceStat.uri}' file to an existing location.`,
        );
      }
      throw FileSystemError.FileNotDirectory(
        targetStat.uri,
        `Cannot move '${sourceStat.uri}' directory to an existing location.`,
      );
    }
    const [sourceMightHaveChildren, targetMightHaveChildren] = await Promise.all([
      this.mayHaveChildren(_sourceUri),
      this.mayHaveChildren(_targetUri),
    ]);
    // Handling special Windows case when source and target resources are empty folders.
    // Source should be deleted and target should be touched.
    if (
      !isCapitalizedEqual &&
      overwrite &&
      targetStat &&
      targetStat.isDirectory &&
      sourceStat.isDirectory &&
      !sourceMightHaveChildren &&
      !targetMightHaveChildren
    ) {
      // 当移动路径跟目标路径均存在文件，同时排除大写路径不等时才进入该逻辑
      // 核心解决在 Mac 等默认大小写不敏感系统中的文件移动问题
      // The value should be a Unix timestamp in seconds.
      // For example, `Date.now()` returns milliseconds, so it should be divided by `1000` before passing it in.
      const now = Date.now() / 1000;
      await fse.utimes(FileUri.fsPath(_targetUri.toString()), now, now);
      await fse.rmdir(FileUri.fsPath(_sourceUri.toString()));
      const newStat = await this.doGetStat(_targetUri, 1);
      if (newStat) {
        return newStat;
      }
      throw FileSystemError.FileNotFound(
        targetUri.path,
        `Error occurred when moving resource from '${sourceUri.toString()}' to '${targetUri.toString()}'.`,
      );
    } else if (
      overwrite &&
      targetStat &&
      targetStat.isDirectory &&
      sourceStat.isDirectory &&
      !targetMightHaveChildren &&
      sourceMightHaveChildren
    ) {
      // Copy source to target, since target is empty. Then wipe the source content.
      const newStat = await this.copy(sourceUri, targetUri, { overwrite });
      await this.delete(sourceUri, { moveToTrash: false });
      return newStat;
    } else {
      await fse.move(FileUri.fsPath(_sourceUri.toString()), FileUri.fsPath(_targetUri.toString()), { overwrite });
      const stat = await this.doGetStat(_targetUri, 1);
      if (stat) {
        return stat;
      } else {
        throw FileSystemError.FileNotFound(_targetUri.path);
      }
    }
  }

  protected async doGetStat(uri: Uri, depth: number): Promise<FileStat | undefined> {
    try {
      const filePath = uri.fsPath;
      const lstat = await fse.lstat(filePath);

      if (lstat.isSymbolicLink()) {
        let realPath;
        try {
          realPath = await fse.realpath(FileUri.fsPath(new URI(uri)));
        } catch (e) {
          return undefined;
        }
        const stat = await fse.stat(filePath);
        const realURI = FileUri.create(realPath);
        const realStat = await fse.lstat(realPath);

        let realStatData;
        if (stat.isDirectory()) {
          realStatData = await this.doCreateDirectoryStat(realURI.codeUri, realStat, depth);
        } else {
          realStatData = await this.doCreateFileStat(realURI.codeUri, realStat);
        }

        return {
          ...realStatData,
          type: FileType.SymbolicLink,
          isSymbolicLink: true,
          uri: uri.toString(),
        };
      } else {
        if (lstat.isDirectory()) {
          return await this.doCreateDirectoryStat(uri, lstat, depth);
        }
        const fileStat = await this.doCreateFileStat(uri, lstat);

        return fileStat;
      }
    } catch (error) {
      if (isErrnoException(error)) {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EBUSY' || error.code === 'EPERM') {
          return undefined;
        }
      }
      throw error;
    }
  }

  protected async doCreateFileStat(uri: Uri, stat: fse.Stats): Promise<FileStat> {
    return {
      uri: uri.toString(),
      lastModification: stat.mtime.getTime(),
      createTime: stat.ctime.getTime(),
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      type: this.getFileStatType(stat),
    };
  }

  protected getFileStatType(stat: fse.Stats) {
    if (stat.isDirectory()) {
      return FileType.Directory;
    }
    if (stat.isFile()) {
      return FileType.File;
    }
    if (stat.isSymbolicLink()) {
      return FileType.SymbolicLink;
    }
    return FileType.Unknown;
  }

  protected async doCreateDirectoryStat(uri: Uri, stat: fse.Stats, depth: number): Promise<FileStat> {
    const children = depth > 0 ? await this.doGetChildren(uri, depth) : [];
    return {
      uri: uri.toString(),
      lastModification: stat.mtime.getTime(),
      createTime: stat.ctime.getTime(),
      isDirectory: true,
      isSymbolicLink: stat.isSymbolicLink(),
      children,
      type: FileType.Directory,
    };
  }

  protected async doGetChildren(uri: Uri, depth: number): Promise<FileStat[]> {
    const _uri = new URI(uri);
    const files = await fse.readdir(FileUri.fsPath(_uri));
    const children = await Promise.all(
      files.map((fileName) => _uri.resolve(fileName)).map((childUri) => this.doGetStat(childUri.codeUri, depth - 1)),
    );
    return children.filter(notEmpty);
  }

  async getFileType(uri: string): Promise<string | undefined> {
    try {
      // 兼容性处理，本质 disk-file 不支持非 file 协议的文件头嗅探
      if (!uri.startsWith('file:/')) {
        return this._getFileType('');
      }
      // const lstat = await fs.lstat(FileUri.fsPath(uri));
      const stat = await fse.stat(FileUri.fsPath(uri));

      let ext = '';
      if (!stat.isDirectory()) {
        // if(lstat.isSymbolicLink){

        // }else {
        if (stat.size) {
          const type = await fileType.stream(fse.createReadStream(FileUri.fsPath(uri)));
          // 可以拿到 type.fileType 说明为二进制文件
          if (type.fileType) {
            ext = type.fileType.ext;
          }
        }
        return this._getFileType(ext);
        // }
      } else {
        return 'directory';
      }
    } catch (error) {
      if (isErrnoException(error)) {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EBUSY' || error.code === 'EPERM') {
          return undefined;
        }
      }
    }
  }

  private _getFileType(ext: string) {
    let type = 'text';

    if (EXT_LIST_IMAGE.indexOf(ext) !== -1) {
      type = 'image';
    } else if (EXT_LIST_VIDEO.indexOf(ext) !== -1) {
      type = 'video';
    } else if (ext && ['xml'].indexOf(ext) === -1) {
      type = 'binary';
    }

    return type;
  }
}
