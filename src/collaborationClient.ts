import * as vscode from 'vscode';
import { io, Socket } from 'socket.io-client';

export class CollaborationClient {
  private socket: Socket;
  private isApplyingRemoteChange = false;

  constructor(serverUrl: string) {
    this.socket = io(serverUrl);
    this.setupListeners();
  }

  private setupListeners() {
    // Terima perubahan dari user lain
    this.socket.on('text-change', (data) => {
      this.applyRemoteChange(data);
    });

    // Terima posisi cursor user lain
    this.socket.on('cursor-update', (data) => {
      this.showRemoteCursor(data);
    });
  }

  private applyRemoteChange(data: any) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    this.isApplyingRemoteChange = true;
    editor.edit(editBuilder => {
      const range = new vscode.Range(
        data.startLine, data.startChar,
        data.endLine, data.endChar
      );
      editBuilder.replace(range, data.text);
    }).then(() => {
      this.isApplyingRemoteChange = false;
    });
  }

  setupDocumentSync() {
    vscode.workspace.onDidChangeTextDocument(event => {
      if (this.isApplyingRemoteChange) return; // Hindari loop

      const changes = event.contentChanges.map(change => ({
        text: change.text,
        startLine: change.range.start.line,
        startChar: change.range.start.character,
        endLine: change.range.end.line,
        endChar: change.range.end.character,
      }));

      this.socket.emit('text-change', { changes });
    });
  }

  async createRoom(): Promise<string> {
    return new Promise(resolve => {
      this.socket.emit('create-room', (roomId: string) => resolve(roomId));
    });
  }

  async joinRoom(roomId: string) {
    this.socket.emit('join-room', roomId);
    this.setupDocumentSync();
  }

  disconnect() { this.socket.disconnect(); }
}