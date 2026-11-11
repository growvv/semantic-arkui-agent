import { socket } from '@kit.NetworkKit';
import { FrameNode, UIContext } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SemanticAction, SemanticSpec, SemanticState } from './Sem';

const DOMAIN = 0x0000;
const TAG = 'SemanticBridge';
const PORT = 18765;

export interface SemanticNode {
  ref: string;
  id: string;
  type: string;
  role: string;
  meaning: string;
  entityKind?: string;
  entityKey?: string;
  state?: SemanticState;
  actions?: SemanticAction[];
  risk?: string;
  passthrough?: boolean;
  parentRef?: string;
  visible: boolean;
}

interface Viewport {
  width: number;
  height: number;
}

export interface SemanticSnapshot {
  schemaVersion: number;
  revision: number;
  viewport: Viewport;
  nodes: SemanticNode[];
  error?: string;
}

interface BridgeRequest {
  id?: number;
  op?: string;
  ref?: string;
}

interface BridgeResponse {
  id?: number;
  ok: boolean;
  result?: Object;
  error?: string;
}

interface PingResult {
  pong: boolean;
}

export class SemanticBridge {
  private static server: socket.TCPSocketServer | undefined;
  private static uiContext: UIContext | undefined;
  private static revision: number = 0;
  private static lastContent: string = '';
  private static readonly ENABLED: boolean = true;

  static start(uiContext: UIContext): void {
    if (!SemanticBridge.ENABLED || SemanticBridge.server !== undefined) {
      return;
    }
    SemanticBridge.uiContext = uiContext;
    SemanticBridge.startServer();
  }

  static stop(): void {
    const server = SemanticBridge.server;
    SemanticBridge.server = undefined;
    SemanticBridge.uiContext = undefined;
    if (server !== undefined) {
      server.close().catch(() => {});
    }
  }

  private static startServer(): void {
    const server = socket.constructTCPSocketServerInstance();
    server.on('connect', (connection: socket.TCPSocketConnection) => {
      connection.on('message', (value: socket.SocketMessageInfo) => {
        SemanticBridge.handle(connection, value.message);
      });
      connection.on('close', () => {});
    });
    server.listen({ address: '127.0.0.1', port: PORT, family: 1 }).then(() => {
      hilog.info(DOMAIN, TAG, 'listening on 127.0.0.1:%{public}d', PORT);
    }).catch((error: Object) => {
      hilog.error(DOMAIN, TAG, 'listen failed %{public}s', JSON.stringify(error));
    });
    SemanticBridge.server = server;
  }

  private static handle(connection: socket.TCPSocketConnection, value: ArrayBuffer): void {
    let request: BridgeRequest;
    try {
      const text = new util.TextDecoder().decodeToString(new Uint8Array(value));
      request = JSON.parse(text) as BridgeRequest;
    } catch (error) {
      SemanticBridge.send(connection, { ok: false, error: 'BAD_REQUEST' });
      return;
    }

    const requestId = request.id;
    if (request.op === 'ping') {
      const pong: PingResult = { pong: true };
      SemanticBridge.send(connection, { id: requestId, ok: true, result: pong });
      return;
    }

    const uiContext = SemanticBridge.uiContext;
    if (uiContext === undefined) {
      SemanticBridge.send(connection, { id: requestId, ok: false, error: 'UI_CONTEXT_UNAVAILABLE' });
      return;
    }

    uiContext.runScopedTask(() => {
      try {
        if (request.op === 'snapshot') {
          SemanticBridge.send(connection, {
            id: requestId,
            ok: true,
            result: SemanticBridge.buildSnapshot(uiContext)
          });
          return;
        }
        if (request.op === 'prepare') {
          const ref = request.ref ?? '';
          const snapshot = SemanticBridge.buildSnapshot(uiContext);
          const node = snapshot.nodes.find((item: SemanticNode) => item.ref === ref);
          if (node === undefined) {
            SemanticBridge.send(connection, { id: requestId, ok: false, error: 'STALE_REFERENCE' });
          } else {
            SemanticBridge.send(connection, { id: requestId, ok: true, result: node });
          }
          return;
        }
        SemanticBridge.send(connection, { id: requestId, ok: false, error: 'UNKNOWN_OP' });
      } catch (error) {
        SemanticBridge.send(connection, {
          id: requestId,
          ok: false,
          error: 'SNAPSHOT_FAILED: ' + JSON.stringify(error)
        });
      }
    });
  }

  private static buildSnapshot(uiContext: UIContext): SemanticSnapshot {
    const root = uiContext.getFrameNodeById('sem.root');
    const nodes: SemanticNode[] = [];
    if (root === null) {
      return {
        schemaVersion: 1,
        revision: SemanticBridge.revision,
        viewport: { width: 0, height: 0 },
        nodes: nodes,
        error: 'ROOT_NOT_FOUND'
      };
    }
    SemanticBridge.visit(root, '', nodes);
    const content = JSON.stringify(nodes);
    if (content !== SemanticBridge.lastContent) {
      SemanticBridge.lastContent = content;
      SemanticBridge.revision += 1;
    }
    return {
      schemaVersion: 1,
      revision: SemanticBridge.revision,
      viewport: { width: 1080, height: 2406 },
      nodes: nodes
    };
  }

  private static visit(node: FrameNode, parentRef: string, nodes: SemanticNode[]): void {
    let currentParent = parentRef;
    const raw = node.getCustomProperty('sem');
    if (raw !== undefined) {
      const spec = raw as SemanticSpec;
      nodes.push({
        ref: spec.id,
        id: spec.id,
        type: node.getNodeType(),
        role: spec.role,
        meaning: spec.meaning,
        entityKind: spec.entityKind,
        entityKey: spec.entityKey,
        state: spec.state,
        actions: spec.actions,
        risk: spec.risk,
        passthrough: spec.passthrough,
        parentRef: parentRef.length > 0 ? parentRef : undefined,
        visible: node.isVisible()
      });
      currentParent = spec.id;
    }

    const count = node.getChildrenCount();
    for (let index = 0; index < count; index++) {
      const child = node.getChild(index);
      if (child !== null) {
        SemanticBridge.visit(child, currentParent, nodes);
      }
    }
  }

  private static send(connection: socket.TCPSocketConnection, response: BridgeResponse): void {
    connection.send({
      data: JSON.stringify(response) + '\n',
      encoding: 'UTF-8'
    }).catch(() => {});
  }
}
