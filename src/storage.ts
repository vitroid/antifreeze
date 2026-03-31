export type DirEntry = {
  path: string;
  name: string;
  isDir: boolean;
};

export interface StorageProvider {
  readonly kind: string;

  listDirectory(dirPath: string): Promise<DirEntry[]>;
  readFile(filePath: string): Promise<{ path: string; text: string }>;
  writeFile(filePath: string, content: string, overwrite: boolean): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
}
