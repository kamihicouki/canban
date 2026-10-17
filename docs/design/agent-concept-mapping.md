# 元アプリの概念対応と観測モデル

2026-10-17、Task 1（P1/P2）。既存のカードID・project/folder・カテゴリ・API引数・開始処理・状態キーを維持する互換追加。分類移行、UI表示、開始経路の変更は後段で扱う。

## 採用した用語と受け持ち

共通操作とCanban独自の整理は共通語を使い、元アプリの所属・整理・開始設定は出典付きで分ける。カテゴリはCanbanが所有し、名前一致による新しい対応付けをこのモデルで行わない。

| Canbanの表現 | 意味 | Codexとの対応 | Claudeとの対応 |
|---|---|---|---|
| ボード | 仕事を横断して見る面 | 元アプリに同一の概念を要求しない | 同左 |
| リスト | ボード上でカードを置くまとまり | Canbanが所有 | Canbanが所有 |
| カテゴリ | 仕事の目的・領域をまとめる区分。1カードは1つまたは未分類 | Project等を明示的に対応付け可能 | 環境・Group等を明示的に対応付け可能 |
| ラベル | カードに複数付ける補助分類 | 元アプリの分類とは独立 | 同左 |
| タスクカード | Canbanで管理する仕事と完了条件 | Threadや内部Taskへ自動的に置き換えない | Session、team Task、background taskへ置き換えない |
| セッションカード／セッション | 追加依頼できる一つの会話・作業履歴 | Thread/Chat | Code Session。Projects内Threadも対応を検証した範囲で扱う |
| 追加依頼 | 一つのセッションへ送る新しい依頼 | 次のターンを開始するuser input | 次のターンを開始するuser message |
| 応答 | 追加依頼に対するエージェントの応答 | Turnの応答。内部Itemの単位とは分ける | Turnの応答。Transcript内Messageとは分ける |
| AI Apps／AI App | 仕事を行う製品の種類 | Codex | Claude Code。Chat/Coworkは将来別の取得面として識別 |
| 元アプリの属性 | 出典付きの所属・整理・開始情報の総称 | 以下の固有属性を含む | 以下の固有属性を含む |
| Codexのプロジェクト | Codexに登録された実際のProject | ProjectのIDと所属 | 対応物を無理に作らない |
| Claudeの環境 | 再利用する名前付き開始設定 | 単一のProjectへの置換はしない | 名前付き環境プリセット。フォルダ、branch/worktree等を含む |
| Codexのセクション | 元アプリの一覧上の整理 | Sidebar section | Claude Groupと自動同一視しない |
| Claudeのグループ | 確認できた手動整理の情報 | Codex Sectionと機能が重なる部分を記録 | 手動Group。現行UI名・取得範囲が確認できない場合はその旨を表示 |
| 開始設定 | 新しいセッションの開始条件を選ぶ共通領域の名前 | Project、Local setup、実行先、Cloud environment等の組合せ | 環境と、その環境が指す実行先・設定 |
| 実行先 | 処理を動かす場所 | このマシン／接続マシン／クラウド | Local／SSH／WSL／Cloud／Remote Controlの実体 |
| マシン | 接続・ファイル・プロセスを持つ実機または接続先 | Local/remote host | Local/SSH/Remote Controlの接続先。Cloudを架空の実機として扱わない |
| 作業フォルダ | 実際に読み書きするディレクトリ | cwd、Project roots | cwd、追加フォルダ。複数を保持 |
| リポジトリ | Gitの履歴管理単位 | Repository | Repository |
| ブランチ | Gitの履歴上の枝 | Branch | Branch |
| Worktree | 同じGitリポジトリの分離した作業コピー | Managed/permanent worktree等の種類も保持 | Worktree。環境のフォルダごとの設定も保持 |
| クラウド環境 | クラウドで再利用する準備・アクセス設定 | Cloud environment | Cloud environment。構成・利用条件の差を残す |
| 計画 | 実行手順と各段階の進捗 | Plan/steps | Plan、Task list等。元の粒度も保持 |
| 目標 | 作業を続ける完了条件・制約 | Goal | Goal。長期統括Projectsそのものとは別 |
| サブエージェント | 親が仕事を分担した実行主体 | Subagent/role/親子Thread | Subagent。Teamや独立Sessionとは別 |
| 元アプリで開く | 元のセッション・設定等へ移る | 確認済みのdeep link/公式操作 | 確認済みのdeep link/公式操作 |

「ワークスペース」はCanbanの画面構成を表す既存語の範囲に留め、Project/Environment/Organizationの総称として増やさない。「環境」は常にClaudeの名前付き環境、クラウド環境、環境変数等の意味が分かる修飾を付ける。


## 20分野の受け持ち


区分: **共通操作**=Canbanに既存の操作体系で提供、**表示・絞り込み**=取得して見せる、**元アプリ**=設定・実行は元アプリで行う、**関連情報**=存在と参照先を扱う。提供条件は操作ごとの能力で判断する。

| 分野 | Canbanでの表現・受け持ち | 元アプリとの対応・扱い |
|---|---|---|
| 01 利用面 | AI App、開く方法（アプリ／CLI）、実行先 | Desktop/CLI/IDE/Web/Mobile/SDKを記録。SDK等を新しいボードページにしない |
| 02 会話・実行単位 | セッション、追加依頼、応答、会話の履歴 | Thread/Sessionを共通表示。Task/Turn/Item/Messageの原語は診断・詳細に保持 |
| 03 所属・整理 | カテゴリと、出典付きの元アプリ属性 | Project/Group/Section/Pin/Archiveを分ける。Canbanの既読や配置と元アプリ側を連動させる場合は明示 |
| 04 名前付き開始設定 | 作成・開始UI内の開始設定 | Claudeの環境、Codex Project＋Local/Cloud setup。名前だけで相互変換しない |
| 05 作業対象・Git | 作業フォルダ、リポジトリ、ブランチ、Worktree | 属性・変更レビューとして表示。チェックアウト・Rewind・ファイルの巻き戻し操作は提供しない |
| 06 実行基盤・接続 | 実行先、マシン、接続状態 | Local/SSH/WSL/Cloud/Remote Controlを能力に応じて開始に使う。接続設定の所有者を保つ |
| 07 環境準備 | 開始設定の適用範囲、元アプリで確認 | Setup/Install/Actions/env vars/secrets/networkを参照。秘密値のコピーや設定変更は行わない |
| 08 継続・履歴操作 | 元アプリで開く、追加依頼、対応する履歴操作 | Resume/Fork/Side chat/Steering/Queue/Handoff等は別能力。追加依頼と実行中への割り込みを同一視しない |
| 09 計画・長期作業 | カードの計画、目標、進捗の表示 | Plan/Goal/Budget/長期作業。既存Canbanのループ機能とは実行主体を区別 |
| 10 複数エージェント | 親子関係、関連セッション、分担の進捗 | Subagent/Team/Agent view/Projects/Workflowを区別。元のTeam構成をCanbanのリストに変換しない |
| 11 文脈・記憶 | 詳細での情報・参照先 | AGENTS.md/CLAUDE.md/Rules/Context/Compaction/Memory/Knowledge等を区別。編集は元アプリまたは通常の開発作業 |
| 12 ツール・拡張 | 入力欄の既存スキル選択、実行履歴、設定への入口 | Skill/Plugin/MCP/Connector/Command/Hook/Mod/LSP/WebMCPを同じ「スキル」にまとめない。導入・接続設定は元アプリ |
| 13 ファイル・実行 | 読み取り専用の変更・出力表示、カードのターミナル | Read/Search/Edit/Shell/Tool callを履歴として表示。ターミナルはユーザーが入力し、Canbanからコマンドを注入しない |
| 14 視覚・音声等 | 添付・成果物・プレビュー、元アプリで開く | Browser/Computer use/Appshots/Record & Replay/Simulator/Voice等の実行エンジンは元アプリ |
| 15 権限・隔離 | 権限の説明、待機理由、元アプリで答える | Approval/Permission/Sandbox/Trust/Auto-review等は元のモデルを保つ。Canbanに承認ボタンを置かない |
| 16 自動化 | Canbanの「自動化」と「元アプリの自動化」を区別 | Scheduled task/Heartbeat/Routine/Loop/Channel等の所有者・定義と各runを分ける。二重起動しない |
| 17 成果・レビュー | 変更、PR、レビュー結果、成果物 | Git/Code review/Security/Ultrareview/Artifacts等を出典付きで表示。通常レビューとSecurityの結果を混ぜない |
| 18 モデル・利用 | モデル、推論の設定、Agent Usage、アカウント | Model/Provider/Effort/Context/Token/Rate limit/課金を分ける。使用量から残量への換算契約を保つ |
| 19 設定・運用 | アカウント、マシン、取得状況、診断情報 | 設定scope/profile/org/policy/sync/retention等を区別。認証情報や権限の自動変更は行わない |
| 20 関連製品 | 対応する情報に製品名を付けて表示 | ChatGPT Work/Space/Pages/Dots/Sites、Claude Chat/Cowork/新ProjectsをCodeの機能と区別。取得Adapter追加は別の実装単位 |

調査した機能のすべてをCanban内で再実装する計画ではない。各機能を「操作」「表示」「元アプリ」「関連情報」のどこで扱うかを確定する計画である。


## 状態と寿命


| 現行の内部状態 | 推奨表示 | 意味 |
|---|---|---|
| `running` | 実行中 | 現在のターンが動いている |
| `waiting` | 入力待ち | 人への質問・許可・計画確認等。待機理由は別に保持 |
| `completed` | 応答済み | 最後のターンが終了。タスクカードやGoalの達成を意味しない |
| `aborted` | 中断 | 最後のターンが中断された。失敗と自動同一視しない |
| `idle` | 待機中 | 直近の実行状態を示す活動がない。過去の成功を断定しない |
| `statusKnown === false` | 状態未取得 | 取得できていない。未実行・完了のどちらにも置き換えない |

内部キーは初期段階で維持し、UIと自動化の説明を先に正す。`lastTurnOutcome`（終了・中断・失敗・未確認）、`goalResolution`（元アプリが確認した達成等）、Canbanタスクの完了は別属性にする。新しい属性は明示的な根拠がある場合だけ埋める。

Claude Agent viewのCompletedグループには失敗・停止も含まれる。グループ名だけから成功状態へ変換しない。時間切れや古いログで実行状態が曖昧な場合は鮮度・取得状況を残し、成功・停止を推定しない。

寿命モデルの「動いている／新しい／今週／休眠中」と密度は現行の契約を維持する。自動化の既存`status:completed`は最後の応答終了という意味を維持し、タスクの完了処理へ変更しない。


## 公開Interface v1

`server/source-model.mjs` は読み取りモデルだけを生成し、保存・送信・元アプリの変更を行わない。

```ts
type SourceRef = {
  provider: string; identityDomain: string; scopeId: string;
  kind: string; nativeId: string;
};
sourceKey(ref: SourceRef | null): string | null;
// JSON.stringify([1, provider, identityDomain, scopeId, kind, nativeId])。
// 全項目が空でない文字列である場合のみ返す。表示名・取得面は識別に含めない。

type Observation<T> = {
  value: T | null;
  status: 'known' | 'absent' | 'unknown' | 'unavailable' | 'stale';
  observedAt: number | null; // Unix milliseconds。取得した時刻。stale時は元の取得時刻を保つ
  sourceUpdatedAt: number | null; // 元データの更新時刻。取得時刻とは別
  source: string | null;
  reason: string | null;
};
type SourceEntity = {
  ref: SourceRef; key: string; name: string | null;
  product: string | null; surface: string | null;
  roots: string[]; hostId: string | null; workingLocations: WorkingLocation[];
};
type WorkingLocation = {
  executionTarget: 'local' | 'ssh' | 'remote' | 'cloud' | 'wsl' | 'remote-control' | null;
  machineId: string | null;
  folder: string | null; repository: string | null;
  branch: string | null; worktree: string | null; primary: boolean;
  branchRequested: string | null; worktreeRequested: boolean | null;
};
type SourceRelation = {
  type: 'memberOf' | 'displayedIn' | 'requestedWith' | 'startedWith';
  ref: SourceRef; key: string;
  observation: Observation<SourceEntity>; requestId: string | null;
};
type SessionSourceView = {
  version: 1;
  attributes: {
    codexProject: Observation<SourceEntity>;
    codexSection: Observation<SourceEntity>;
    claudeGroup: Observation<SourceEntity>;
    claudeEnvironment: Observation<SourceEntity>;
  };
  relations: SourceRelation[];
  workingLocations: Observation<WorkingLocation[]>;
};
sessionSourceView(
  session: Session,
  catalog: { entities?: SourceEntity[] } = {},
  receipts: LaunchReceipt[] = []
): SessionSourceView;

type LaunchReceipt = {
  requestId?: string; sessionId: string; status: string;
  selectedRefs?: SourceRef[]; appliedRefs?: SourceRef[];
  observedAt?: number;
};
```

- `session.sourceMetadata` の各値は `{ref,name,product,surface,roots?,hostId?,workingLocations?,status,observedAt,sourceUpdatedAt?,source,reason?}`。Adapterが実際の出典とscopeを確定できた属性だけを供給する。`claudeEnvironment` はAdapter由来の値を採用せず、confirmed ReceiptのappliedRefsだけから属性を生成する。
- `known` は取得した値、`absent` は取得済みで存在しないと確認したもの、`unknown` は未取得・scope不明、`unavailable` は取得不能、`stale` は前回の取得値。`absent` の値は `null`、作業場所の確認済み空集合は `[]`。古い値は値と元の時刻を保持する。
- `catalog.entities` は同じ `sourceKey` の表示名を更新するためだけに使う。名前・cwd・Project rootsの一致は所属や開始環境の証拠にしない。古い所属のrelationは `observation.status:'stale'` のまま返す。
- Codex Project は `memberOf`、Codex Section と Claude Group は `displayedIn`。Claude環境のカタログが存在しても `startedWith` は作らない。
- Receiptは `status:'confirmed'` かつ `sessionId === session.id` のときだけ関連付ける。選択した参照は `requestedWith`、適用した参照だけが `startedWith`。今回Receiptの生成・保存・開始処理は実装しない。後段は元アプリからの適用確認を得てから渡す。
- `session.workingLocations` が配列なら全件の許可したフィールドを保持する。なければ確認できた `cwd` を1件の作業場所にする。cwdから元アプリ所属を逆算しない。クラウドはcwdによるローカルフォルダ補完を行わず、論理cloud hostを実機IDに流用しない。Codex Projectの全rootsは `SourceEntity.roots` であり、すべてがそのセッションの実際の作業場所とは断定しない。
- `lastTurnOutcome` / `goalResolution` / Taskの完了は将来の独立属性。最後の応答終了だけでは作成せず、今回UIや自動化の状態名は変更しない。

`storageScope(path): string | null` は保存領域専用の正規化境界。`~` を展開し、realpath成功時は実体の絶対パス、失敗時はresolveした絶対パスを返す。nativeId・account・orgはtrimや正規化をせず、元の値を識別子に保持する。保存領域を移動・再作成した場合はscopeが変わりうるため、管理パネルで対応を再確認する（自動で名前一致結合しない）。

`executionTarget:'ssh'` はSSHで取得したremote session、`'remote'` は手段が未確定のremote、他は値どおり。未取得・未知の値はnull。`branch` / `worktree` は実際の作業状態、`branchRequested` / `worktreeRequested` はプリセットの要求設定。要求から実際の状態を生成しない。作業場所の取得時刻がAdapterで分からなければ `observedAt:null` とし、会話の最終更新は `sourceUpdatedAt` に置く。

### 実際のAdapterと取得限界

Codexのremote Project所属は、ローカルapp保存領域とセッションのhomeが一致し、明示assignment先のremote Project.hostIdとsession.host.idが一致するときだけknown（古いsnapshotはstale）にする。別host・不明host・別home・cloudはunknown。remote Sectionはremote DB由来なので引き続きunknownとする。

| Adapter | 根拠とscope | 観測の範囲・限界 |
|---|---|---|
| Codex app | 読んだ `.codex-global-state.json` の `CODEX_HOME` 絶対パス。`identityDomain:app-storage` | 明示的なthread assignmentだけをProject所属にする。所有アカウントは未確認でも、実体を所有するアプリ保存領域は確認できる。Cloud組織のscopeとして流用しない。壊れたJSON時の前回値にはstaleを付け、元の観測時刻を保つ |
| Codex section | ローカル状態DBから読み取ったsection IDと、その保存領域 | ローカルappと保存領域が一致する場合だけ参照化。別profile・remote側のsectionはscope未取得として扱う。出典はcodex-dbとし、JSONの時刻をDBの観測時刻に流用せずobservedAt:nullにする。section無しをDB schema未確認のままabsentにしない |
| Claude group | Desktopメタデータの実際のgroup ID、読取元sessions保存領域、メタデータフォルダのaccount/org | `identityDomain:desktop-account-org`、`scopeId:JSON.stringify([sessionsDir, account, org])`。nameしかない旧group、guestコピー、複数所有scopeのメタデータが競合する場合はunknown。セッション所有者とgroup名前空間の所有者を分ける。guestのgroup IDがhost/元ownerのどちらかは実証できていないため参照化しない。複数scopeの一覧整理は後段 |
| Claude preset | `ccd-session-presets.json` のsigned-in accountと実際のpreset ID | `identityDomain:preset-account`、`scopeId:JSON.stringify([appDir, account])`。既存local/ssh対象へ `sourceRef` / `sourceObservation` / `workingLocations` / `settingsPresence` を追加。開始設定のフォルダごとのbranchと `worktreeRequested` は要求設定であり、実際に作られたWorktreeではない |
| Codex launch target | 読取元app保存領域とProject ID、全roots | 既存Projectへ `sourceRef` / `sourceObservation` を追加。Cloudカタログは所有組織scopeを確認できないため、既存のid/nameを保持し確定SourceRefを捏造しない |

Claude presetの `additionalFolders` / `folderSettings[folder].branch` / `.worktree` は、2026-10-17にインストール済みeditorの復元・保存分岐で確認した（`/Applications/Claude.app/Contents/Resources/ion-dist/assets/v1/ca690a791-BG2HOgzO.js`）。環境変数は別のscoped取得なので、`settingsPresence.environmentVariables:'unknown'` とする。秘密値や未知のraw設定をコピーしない。`folderSettings` の有無は `'known'|'unknown'`。

`SourceRelation` は履歴の意味を持ち、`CategoryBinding` はCanbanカテゴリへの明示的対応を持つ。`LaunchSelection` は指定した開始先と適用範囲、`LaunchReceipt` は適用結果を持つ。Taskの開始指定 `sourceContext` とリンクから観測した `sourceRelations` は後段で別々に扱う。今回これらの保存や分類を先取りしない。

### 操作能力

```ts
type Capability = {
  operation: string;
  status: 'available' | 'blocked' | 'unsupported' | 'unknown';
  reason: string | null; targetId: string | null;
  routes?: {desktop: {status: Capability['status']; reason: string | null}; terminal: {status: Capability['status']; reason: string | null}};
};
type Operation = 'open'|'start'|'sendPrompt'|'archive'|'restore'|'delete'|'fork'|'interrupt'|'pin';
type Capabilities = Record<Operation, Capability>;
capabilitiesFor({
  session = null, target = null, account = null, observation = null
}: {
  session?: Session | null;
  target?: { id?: string } | null;
  account?: { id: string } | null;
  observation?: {
    status: Observation<unknown>['status'];
    records?: object[]; mtimeMs?: number; now?: number;
    dispatch?: { enabled: boolean; allowModel?: boolean; allowModelElevated?: boolean };
    origin?: 'ui' | 'model'; allowElevated?: boolean;
  } | null;
}): Record<'open'|'start'|'sendPrompt'|'archive'|'restore'|'delete'|'fork'|'interrupt'|'pin', Capability>;
```

`server/source-capabilities.mjs` から直接公開する。`session-actions.mjs` との循環再exportは行わない。`available` はこの観測で前提を満たすという案内であり、実行許可の証票ではない。`blocked` は状態・ポリシー・アカウント不一致等で停止、`unsupported` はCanbanに実行経路がない操作、`unknown` は必要な観測不足。未利用時の `reason` は必ず返す。

- `open`: 既存 `launchInfo()` の正確なDesktopリンクまたはCLI再開経路。Claudeまたはaccount指定時は `routes:{desktop:{status,reason},terminal:{status,reason}}` を追加する。Desktopは選択accountとの不一致でblocked、Claudeの現在ログインが未確認ならunknown。既存の明示的なCLI再開があれば全体はavailableを保ち、Desktop制約をreasonで説明する。`account.id` はDesktop経路の確認対象であり、既存 `claudeExecution` のCLI実行アカウント選択を無効化・書換しない。
- `archive/restore/delete`: 既存 `sessionActions()` の制約を保持する。Claude・remote・cloudは未対応、running/waitingは停止条件。stale・状態未取得・ID未取得はunknown。選択アカウントと既知の所有アカウントが違えばblocked、所有アカウントを取得できなければunknown。
- `sendPrompt`: 既存 `staticProblem()`、`timingProblem()`、`permissionFor()`、dispatch設定を使う。最新ログ・mtime・設定なしはunknown。running/waiting、送信無効、model送信禁止、制限なし権限の確認なしはblocked。modelは `allowElevated:true` だけで権限を上げられない。実行中へのsteer・承認回答・queueとは別能力。
- `start`: 今回開始経路の全適用可否を確認しないためunknown。フォルダや名前付き環境の存在だけでavailableにしない。
- `fork/interrupt/pin`: 今回共通操作として未対応。新しい元アプリ操作は解禁しない。

既存 `codexLifecycle()` と Dispatcherの実行直前の再取得・状態・権限・競合・レート・アカウントのguardをそのまま残す。capabilitiesは実行ガードの置き換えではない。

### 互換の公開位置とfixture

ボードの既存セッションカード、Taskのlinks、セッション詳細に `sourceView` と `capabilities` を追加する。既存 `actions`、project/folder/native属性、保存データ、カードIDは維持する。ボード取得だけではログの権限を新たに読み込まないので、送信能力はunknownで返す。新しいUI操作・レイヤー・キーは追加しない。

fixtureは `tests/source-model.test.mjs`（同名別scope、rename、複数folder、未取得/なし/stale、明示所属、cwd非推定、正確なreceipt、board/detail互換）、`tests/source-capabilities.test.mjs`（既存履歴制約、送信権限・観測・account）と既存Adapterテストの追加分に固定する。

### ボード転送形式 v1 と再構築入口

完全な `sessionSourceView()` / `capabilitiesFor()` の返却型と、セッション詳細のshapeは上記のまま。ボードのカードとタスクlinksだけは、次の転送形式を使う。リンク自身に必要な情報を持つため、セッションが独立カードとして非表示・フィルター対象外でも欠けない。既存linksの全フィールドは維持する。

```ts
compactSourceView(full: SessionSourceView): {
  version: 1; compact: true;
  attributes: Partial<SessionSourceView['attributes']>;
  relations: (SourceRelation | {type: SourceRelation['type']; attribute: keyof SessionSourceView['attributes']; requestId: string | null})[];
  workingLocations?: Observation<WorkingLocation[]>;
};
expandSourceView(wire: CompactSourceView | SessionSourceView): SessionSourceView;
type CompactSourceView = ReturnType<typeof compactSourceView>;

compactCapabilities(full: Capabilities): {
  version: 1; compact: true; targetId: string | null;
  operations: Partial<Record<Operation, {status: Capability['status']; reason: string | null; routes?: Capability['routes']; targetId?: string | null}>>;
};
expandCapabilities(wire: CompactCapabilities | Capabilities): Capabilities;
type CompactCapabilities = ReturnType<typeof compactCapabilities>;
```

`compactSourceView` / `expandSourceView` は `server/source-model.mjs`、能力のcodecは `server/source-capabilities.mjs` からexportする。完全形を渡したexpandはそのまま返す。Task2の分類・relation集計は転送前の完全Viewを直接利用する。Task3の画面は描画境界でexpandし、完全形のUIモデルを使う。各expand本体と既定値構築は純粋関数であり、セッション取得・カタログ照合・実行可否の再計算はしない。Nodeモジュール自体をbrowserへimportせず、この小さなcodecと既定値境界をUI側の責務ファイルへ移せる。

- 属性省略は `sessionSourceView({})` と完全に一致する場合だけ。既定Observationは `{value:null,status:'unknown',observedAt:null,sourceUpdatedAt:null,source:null,reason}`。codexProject/codexSection/claudeGroupのreasonは `元アプリの属性は未取得です`、claudeEnvironmentは `開始実績のReceiptは未取得です`、workingLocationsは `作業場所は未取得です`。absent/stale/unavailable、独自reasonや出典のあるunknownは省略しない。
- relationの `attribute` は同じ転送オブジェクトのattributesだけを指す。そのObservationからref/key/observationを復元する。requestedWith/startedWithのtypeとrequestIdは保持し、参照できる同一属性がなければ完全relationを送る。別カードへの参照やdanglingなsession IDは作らない。
- 能力の各既定値はoperationと共通targetIdを補完する。open/start/archive/restore/deleteはunknownでreason=`操作条件は未取得です`、sendPromptはunknownでreason=`最新の状態・権限・送信設定は未取得です`。fork/interrupt/pinはunsupportedでreason=`Canbanからの操作には対応していません。元アプリで操作してください`。既定と異なる操作だけoperationsへ入れ、全reason/routes/個別targetIdを保持する。省略を「操作を隠す」と解釈しない。
- 固定fixture: `tests/source-model.test.mjs` のcompact round-tripとboard/full detail比較、`tests/source-capabilities.test.mjs` のcapability round-trip。unknown/absent/stale/unavailable、requestedWith/startedWithをJSON転送前後で比較する。
