import * as vscode from 'vscode'
import { requestLLMReviewWithFunctionCalling, LLM_CONFIG } from './llm-client'

//
const LLM_REVIEWER_CONSOLE = vscode.window.createOutputChannel('llm-reviewer')

// DiagnosticCollection（問題タブ用）を宣言
const diagnosticCollection =
	vscode.languages.createDiagnosticCollection('llm-reviewer')

// 重要度の種類を定義
enum Severity {
	Error = 'error',
	Warning = 'warning',
	Info = 'info',
	Hint = 'hint', // ヒントレベルを追加
}

// レビュー結果のTreeViewアイテム用クラス
class ReviewItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly children: ReviewItem[] = [],
		public readonly description?: string,
		public readonly resourceUri?: vscode.Uri, // ファイルパスを表すため追加
		public readonly severity?: Severity, // 重要度を追加
		public readonly lineNumber?: number, // 行番号を保持
		public readonly colNumber?: number // 列番号を保持
	) {
		super(label, collapsibleState)

		// 説明を設定
		if (description) {
			this.description = description
			this.tooltip = description
		}

		// ファイルパスを持つアイテムの場合、アイコンを設定
		if (resourceUri) {
			this.resourceUri = resourceUri
			this.iconPath = vscode.ThemeIcon.File
		}

		// 重要度に応じてアイコンを設定
		if (severity) {
			switch (severity) {
				case Severity.Error:
					// エラーアイコン（赤）
					this.iconPath = new vscode.ThemeIcon(
						'error',
						new vscode.ThemeColor('errorForeground')
					)
					break
				case Severity.Warning:
					// 警告アイコン（黄）
					this.iconPath = new vscode.ThemeIcon(
						'warning',
						new vscode.ThemeColor('editorWarning.foreground')
					)
					break
				case Severity.Info:
					// 情報アイコン（青）
					this.iconPath = new vscode.ThemeIcon(
						'info',
						new vscode.ThemeColor('editorInfo.foreground')
					)
					break
				case Severity.Hint:
					// ヒントアイコン（白/ライトグレー）
					this.iconPath = new vscode.ThemeIcon(
						'light-bulb',
						new vscode.ThemeColor('editorHint.foreground')
					)
					break
			}
		}

		// 行番号と列番号が指定されている場合、クリックでジャンプする機能を追加
		if (resourceUri && lineNumber !== undefined) {
			this.command = {
				title: '該当箇所へジャンプ',
				command: 'vscode.open',
				arguments: [
					resourceUri,
					{
						selection: new vscode.Range(
							lineNumber > 0 ? lineNumber - 1 : 0,
							colNumber !== undefined ? colNumber : 0,
							lineNumber > 0 ? lineNumber - 1 : 0,
							colNumber !== undefined ? colNumber + 1 : 1
						),
					},
				],
			}
		}
	}
}

// レビュー結果のTreeView用のデータプロバイダークラス
class ReviewTreeDataProvider implements vscode.TreeDataProvider<ReviewItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		ReviewItem | undefined | null | void
	> = new vscode.EventEmitter<ReviewItem | undefined | null | void>()
	readonly onDidChangeTreeData: vscode.Event<
		ReviewItem | undefined | null | void
	> = this._onDidChangeTreeData.event

	// ファイルパスをキーとしてレビューアイテムを保持するMap
	private _reviewItemsByFile = new Map<string, ReviewItem[]>()
	private _treeView?: vscode.TreeView<ReviewItem> // TreeViewインスタンスへの参照を追加

	constructor() {
		LLM_REVIEWER_CONSOLE.appendLine(
			'[llm-reviewer] ReviewTreeDataProvider initialized'
		)
	}

	// TreeViewインスタンスを設定するメソッド
	setTreeView(treeView: vscode.TreeView<ReviewItem>) {
		this._treeView = treeView
	}

	getTreeItem(element: ReviewItem): vscode.TreeItem {
		return element
	}

	getChildren(element?: ReviewItem): Thenable<ReviewItem[]> {
		if (!element) {
			// トップレベル: ファイルパスのリストを表示
			const fileItems: ReviewItem[] = []
			for (const [
				uriString,
				items,
			] of this._reviewItemsByFile.entries()) {
				if (items.length > 0) {
					const uri = vscode.Uri.parse(uriString)

					// ワークスペース相対パスを取得
					const workspaceRelativePath =
						this.getWorkspaceRelativePath(uri)

					// 問題の数を取得
					const errorCount = items.filter(
						(i) => i.severity === Severity.Error
					).length
					const warningCount = items.filter(
						(i) => i.severity === Severity.Warning
					).length
					const infoCount = items.filter(
						(i) => i.severity === Severity.Info
					).length
					const hintCount = items.filter(
						(i) => i.severity === Severity.Hint
					).length

					// ファイル名と問題数を組み合わせたラベル
					// 例: "/src/extension.ts (エラー: 2, 警告: 3)"
					let fileLabel = workspaceRelativePath
					const counts = []

					if (errorCount > 0) {
						counts.push(`エラー: ${errorCount}`)
					}
					if (warningCount > 0) {
						counts.push(`警告: ${warningCount}`)
					}
					if (infoCount > 0) {
						counts.push(`情報: ${infoCount}`)
					}
					if (hintCount > 0) {
						counts.push(`ヒント: ${hintCount}`)
					}

					// 問題数の表示をファイル名の後ろに追加
					if (counts.length > 0) {
						fileLabel = `${workspaceRelativePath} (${counts.join(
							', '
						)})`
					}

					fileItems.push(
						new ReviewItem(
							fileLabel, // 指摘数を含むラベル
							vscode.TreeItemCollapsibleState.Expanded,
							items,
							uri.fsPath, // description にフルパス
							uri // resourceUri に URI を設定
						)
					)
				}
			}
			return Promise.resolve(fileItems)
		}
		// ファイルパスノードの子要素: そのファイルのレビューアイテム
		return Promise.resolve(element.children)
	}

	// URIからワークスペース相対パスを取得するヘルパーメソッド
	private getWorkspaceRelativePath(uri: vscode.Uri): string {
		// ワークスペースフォルダを取得
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders) {
			return uri.path.substring(uri.path.lastIndexOf('/') + 1) // ワークスペースがない場合はファイル名のみ
		}

		// URIのフルパスを取得
		const fullPath = uri.fsPath

		// 各ワークスペースフォルダに対して、パスがそのフォルダ内にあるか確認
		for (const folder of workspaceFolders) {
			const folderPath = folder.uri.fsPath
			if (fullPath.startsWith(folderPath)) {
				// ワークスペースパスからの相対パスを取得し、バックスラッシュをスラッシュに変換（Windows対応）
				const relativePath = fullPath
					.substring(folderPath.length)
					.replace(/\\/g, '/')

				// 最初のスラッシュがない場合は追加
				return relativePath.startsWith('/')
					? relativePath
					: '/' + relativePath
			}
		}

		// ワークスペース内に見つからない場合はファイル名のみ
		return uri.path.substring(uri.path.lastIndexOf('/') + 1)
	}

	// 特定のファイルのレビュー結果を更新する
	update(uriString: string, text: string): void {
		// 対象ファイルのURIを取得
		const uri = vscode.Uri.parse(uriString)

		// テキストからTreeViewアイテムを生成 (URIも渡す)
		const items = this._parseReviewItems(text, uri)
		this._reviewItemsByFile.set(uriString, items)

		// 全ファイルのレビューアイテムの総数を計算
		let totalReviewCount = 0
		for (const items of this._reviewItemsByFile.values()) {
			totalReviewCount += items.length
		}

		// TreeViewのバッジを更新
		if (this._treeView) {
			if (totalReviewCount > 0) {
				this._treeView.badge = {
					value: totalReviewCount,
					tooltip: `${totalReviewCount}件の指摘事項`,
				}
			} else {
				this._treeView.badge = undefined // レビューがなければバッジをクリア
			}
		}

		// 更新を通知
		this._onDidChangeTreeData.fire()
	}

	// レビューテキストを解析してTreeViewアイテムに変換する
	private _parseReviewItems(
		text: string,
		fileUri?: vscode.Uri
	): ReviewItem[] {
		// 重複チェック用のSet
		const uniqueReviews = new Set<string>()
		// レビュー結果アイテムの配列
		const reviewItems: ReviewItem[] = []
		// 行番号ごとのアイテム（行番号の重複を避けるため）
		const lineNumberItems = new Map<number, ReviewItem[]>()

		// <think>タグで囲まれた部分を除外
		let filteredText = text
		const thinkRegex = /<think>[\s\S]*?<\/think>/g
		filteredText = filteredText.replace(thinkRegex, '')

		// テキストを行ごとに分割
		const lines = filteredText
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => {
				// 空行をスキップ
				if (line.length === 0) return false

				// think タグから始まる行をスキップ
				if (line.startsWith('<think>') || line.startsWith('think ')) {
					return false
				}

				// 余計な文言をフィルタリング
				if (
					line.startsWith('Here are') ||
					line.startsWith('以下に') ||
					line.startsWith('レビュー結果') ||
					line.startsWith('コードレビュー') ||
					line.startsWith('指摘事項') ||
					line.includes('---') ||
					line.includes('===') ||
					line.includes('###') ||
					line.includes('```') ||
					line.startsWith('#')
				) {
					return false
				}

				// 行番号表記のみの行をスキップ（例: "L10:" や "行 10:" など）
				if (/^(L|Line|行)\s*\d+:?\s*$/.test(line)) {
					return false
				}

				return true
			})
			.map((line) => {
				// 箇条書き記号を削除
				return line.replace(/^[\s•\-\*\+・・・・]\s*/, '').trim()
			})

		// リソースURIを設定（指定されたURIかアクティブエディタのURIを使用）
		const resourceUri =
			fileUri || vscode.window.activeTextEditor?.document.uri

		// 各行を処理
		for (const line of lines) {
			// 新しい形式の行番号、重要度と内容を抽出する正規表現
			// 形式: 「[重要度]: 指摘内容」 または 「[重要度]: 指摘内容 [Ln X, Col Y]」
			const severityMatch = line.match(
				/^\[(ERROR|WARNING|INFO|HINT)\]\s*:?\s*(.+?)(?:\s+\[Ln\s+(\d+)(?:,\s*Col\s+(\d+))?\])?$/i
			)

			// 新形式にマッチしたら、その情報を使用
			if (severityMatch) {
				const severityText = severityMatch[1].toUpperCase()
				const content = severityMatch[2].trim()
				// 行番号と列番号を取得（存在する場合）
				const lineNumber = severityMatch[3]
					? parseInt(severityMatch[3], 10)
					: undefined
				const colNumber = severityMatch[4]
					? parseInt(severityMatch[4], 10)
					: undefined

				// 重要度を判定
				let severity: Severity
				if (severityText === 'ERROR') {
					severity = Severity.Error
				} else if (severityText === 'WARNING') {
					severity = Severity.Warning
				} else if (severityText === 'INFO') {
					severity = Severity.Info
				} else if (severityText === 'HINT') {
					severity = Severity.Hint
				} else {
					severity = Severity.Info // デフォルト
				}

				// 表示テキストに行番号と列番号の情報を追加
				let displayText = content
				if (lineNumber) {
					displayText = `${displayText}${
						lineNumber ? ` (行 ${lineNumber}` : ''
					}${colNumber ? `, 列 ${colNumber}` : ''}${
						lineNumber ? ')' : ''
					}`
				}

				// 重要度をプレフィックスとして追加（アイコンだけではわかりにくい場合に備えて）
				let severityPrefix = ''
				switch (severity) {
					case Severity.Error:
						severityPrefix = '[エラー] '
						break
					case Severity.Warning:
						severityPrefix = '[警告] '
						break
					case Severity.Info:
						severityPrefix = '[情報] '
						break
					case Severity.Hint:
						severityPrefix = '[ヒント] '
						break
				}

				displayText = severityPrefix + displayText

				const item = new ReviewItem(
					displayText,
					vscode.TreeItemCollapsibleState.None,
					[],
					undefined,
					resourceUri, // 引数で渡されたURIを使用
					severity,
					lineNumber, // 行番号を設定
					colNumber // 列番号を設定
				)

				// 重複を避けるために同じ内容の指摘は追加しない
				const reviewKey = `${severity}-${content}-${lineNumber || 0}-${
					colNumber || 0
				}`
				if (!uniqueReviews.has(reviewKey)) {
					uniqueReviews.add(reviewKey)
					reviewItems.push(item)
				}
			}
		}

		// 行番号でソート（行番号がない場合は最後に）
		reviewItems.sort((a, b) => {
			if (a.lineNumber === undefined && b.lineNumber === undefined) {
				return 0
			}
			if (a.lineNumber === undefined) {
				return 1
			}
			if (b.lineNumber === undefined) {
				return -1
			}
			return a.lineNumber - b.lineNumber
		})

		return reviewItems
	}

	// 特定のファイルのレビュー結果をクリアするメソッドを追加
	clearFileReviews(uriString: string): void {
		if (this._reviewItemsByFile.has(uriString)) {
			this._reviewItemsByFile.delete(uriString)
			this.updateBadge() // バッジも更新
			this._onDidChangeTreeData.fire()
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] Cleared reviews for ${uriString}`
			)
		}
		// 問題タブの診断結果もクリア
		const doc = vscode.workspace.textDocuments.find(
			(d) => d.uri.toString() === uriString
		)
		if (doc) {
			diagnosticCollection.delete(doc.uri)
		}
	}

	// バッジを更新するヘルパーメソッド
	private updateBadge(): void {
		let totalReviewCount = 0
		for (const items of this._reviewItemsByFile.values()) {
			totalReviewCount += items.length
		}

		if (this._treeView) {
			if (totalReviewCount > 0) {
				this._treeView.badge = {
					value: totalReviewCount,
					tooltip: `${totalReviewCount}件の指摘事項`,
				}
			} else {
				this._treeView.badge = undefined
			}
		}
	}
}

// TreeViewプロバイダーを宣言
const reviewTreeProvider = new ReviewTreeDataProvider()

// ドキュメントごとに最後の実行時刻を保持し、30秒以内の再実行を防止
const lastRunMap = new Map<string, number>()

/**
 * ----------------------------  ユーティリティ設定  ----------------------------
 */
// LLM設定は llm-client.ts に移動
const EXCLUDE_PATTERNS = vscode.workspace
	.getConfiguration()
	.get<string[]>('llmLint.excludePatterns') || ['.venv/**', '**/.venv/**']
const INCLUDE_PATTERNS =
	vscode.workspace
		.getConfiguration()
		.get<string[]>('llmLint.includePatterns') || []

function isProgrammingLanguage(languageId: string): boolean {
	const ids = new Set([
		'javascript',
		'typescript',
		'python',
		'java',
		'c',
		'cpp',
		'csharp',
		'ruby',
		'go',
		'php',
		'swift',
		'kotlin',
		'rust',
		'scala',
		'perl',
		'dart',
		'haskell',
		'elixir',
		'clojure',
		'shellscript',
		'bash',
		'powershell',
		'objective-c',
		'groovy',
		'lua',
		'coffeescript',
		'jsonc',
		'vue',
		'jsx',
		'tsx',
	])
	return ids.has(languageId)
}

/**
 * 指定されたパスが除外パターンにマッチするか、または包含パターンにマッチしないかを判定する
 * @param fsPath ファイルシステムパス
 * @returns true:除外する、false:処理対象とする
 */
function shouldExclude(fsPath: string): boolean {
	const { relative } = require('path')
	const { minimatch } = require('minimatch')

	// ワークスペースのフォルダを取得
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return false // ワークスペースがなければ除外しない
	}

	// ファイルのワークスペースからの相対パスを取得
	let relativePath: string | null = null
	for (const folder of workspaceFolders) {
		const folderPath = folder.uri.fsPath
		if (fsPath.startsWith(folderPath)) {
			relativePath = relative(folderPath, fsPath)
			break
		}
	}

	if (relativePath === null) {
		return false // ワークスペース外のファイルは除外しない
	}

	// 相対パスをフォワードスラッシュに正規化（Windowsの互換性のため）
	relativePath = relativePath.replace(/\\/g, '/')

	// includeパターンが指定されている場合、どれかにマッチすれば処理対象に
	if (INCLUDE_PATTERNS.length > 0) {
		const included = INCLUDE_PATTERNS.some((pattern) =>
			minimatch(relativePath!, pattern, { dot: true, matchBase: true })
		)
		// includeパターンにマッチしない場合は除外
		if (!included) {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] Excluding ${fsPath} (does not match include patterns)`
			)
			return true
		}
	}

	// excludeパターンにマッチする
	return EXCLUDE_PATTERNS.some((pattern) =>
		minimatch(relativePath!, pattern, { dot: true, matchBase: true })
	)
}

/**
 * ----------------------------  拡張機能のエントリーポイント  ----------------------------
 */
export async function activate(ctx: vscode.ExtensionContext) {
	LLM_REVIEWER_CONSOLE.appendLine('[llm-reviewer] activate called')

	// ツリービューのみを登録する
	const treeView = vscode.window.createTreeView('llmReviewerView', {
		treeDataProvider: reviewTreeProvider,
	})
	reviewTreeProvider.setTreeView(treeView)

	ctx.subscriptions.push(treeView)

	const { default: PQueue } = await import('p-queue')
	const queue = new PQueue({ concurrency: 1 })

	const lintIfNeeded = (doc: vscode.TextDocument) => {
		if (doc.isUntitled) return
		if (!isProgrammingLanguage(doc.languageId)) return
		// 除外パターンに一致するファイルはスキップ
		if (shouldExclude(doc.uri.fsPath)) {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] Skipping lint for ${doc.fileName} (excluded by pattern)`
			)
			return
		}
		// ★ここで「現在開かれているファイル」かどうかを判定
		const isOpen = vscode.window.visibleTextEditors.some(
			(editor) => editor.document.uri.toString() === doc.uri.toString()
		)
		if (!isOpen) {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] Skipping lint for ${doc.fileName} (not open in any editor)`
			)
			return
		}
		const uri = doc.uri.toString()
		const now = Date.now()
		const last = lastRunMap.get(uri) ?? 0
		if (now - last < 30000) {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] Skipping lint for ${doc.fileName} (cooldown)`
			)
			return
		}
		lastRunMap.set(uri, now)
		queue.add(() => lintDocument(doc), { throwOnTimeout: false })
	}

	// 自動レビューのオンオフを設定（ユーザー設定から読み込む）
	let autoReviewEnabled = true
	// ファイルオープン時の自動レビュー設定をユーザー設定から読み込む
	let autoReviewOnOpenEnabled = vscode.workspace
		.getConfiguration()
		.get<boolean>('llmLint.autoReviewOnOpen', true)

	LLM_REVIEWER_CONSOLE.appendLine(
		`[llm-reviewer] ファイルオープン時の自動レビュー: ${
			autoReviewOnOpenEnabled ? '有効' : '無効'
		}`
	)

	// 手動レビュー実行コマンドを登録
	const reviewCommand = vscode.commands.registerCommand(
		'llm-reviewer.reviewCurrentFile',
		async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				vscode.window.showInformationMessage(
					'レビュー対象のファイルを開いてください'
				)
				return
			}

			const doc = editor.document
			if (doc.isUntitled) {
				vscode.window.showInformationMessage(
					'保存されたファイルのみレビュー可能です'
				)
				return
			}

			if (!isProgrammingLanguage(doc.languageId)) {
				vscode.window.showInformationMessage(
					'サポート対象の言語ファイルではありません'
				)
				return
			}

			// 除外パターンに一致するファイルはスキップ
			if (shouldExclude(doc.uri.fsPath)) {
				vscode.window.showInformationMessage(
					`${doc.fileName} は除外パターンに一致するため、レビューできません`
				)
				return
			}

			// レビュー実行（クールダウンをスキップ）
			lastRunMap.set(doc.uri.toString(), 0) // クールダウンをリセット
			await lintDocument(doc)
		}
	)

	// 自動レビューのオンオフを切り替えるコマンドを登録
	const toggleAutoReviewCommand = vscode.commands.registerCommand(
		'llm-reviewer.toggleAutoReview',
		() => {
			autoReviewEnabled = !autoReviewEnabled
			vscode.window.showInformationMessage(
				`ファイル保存時の自動レビューを${
					autoReviewEnabled ? '有効' : '無効'
				}にしました`
			)
		}
	)

	// ファイルオープン時の自動レビューのオンオフを切り替えるコマンドを登録
	const toggleAutoReviewOnOpenCommand = vscode.commands.registerCommand(
		'llm-reviewer.toggleAutoReviewOnOpen',
		() => {
			autoReviewOnOpenEnabled = !autoReviewOnOpenEnabled
			// 設定も更新する
			vscode.workspace
				.getConfiguration()
				.update(
					'llmLint.autoReviewOnOpen',
					autoReviewOnOpenEnabled,
					vscode.ConfigurationTarget.Global
				)

			vscode.window.showInformationMessage(
				`ファイルオープン時の自動レビューを${
					autoReviewOnOpenEnabled ? '有効' : '無効'
				}にしました`
			)
		}
	)

	// ファイル保存時のイベントハンドラを登録（自動レビュー機能）
	const onSaveSubscription = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (autoReviewEnabled) {
			lintIfNeeded(doc)
		}
	})

	// ファイルオープン時のイベントハンドラを登録（自動レビュー機能）
	const onOpenSubscription = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor && autoReviewOnOpenEnabled) {
				const doc = editor.document
				lintIfNeeded(doc)
			}
		}
	)

	// 既に開いているエディタがあれば、アクティブなものをレビュー
	if (vscode.window.activeTextEditor && autoReviewOnOpenEnabled) {
		const doc = vscode.window.activeTextEditor.document
		// 少し遅延させて実行（起動直後の負荷を軽減）
		setTimeout(() => lintIfNeeded(doc), 2000)
	} else {
		LLM_REVIEWER_CONSOLE.appendLine(
			'[llm-reviewer] 起動時に開かれているファイルがないため、自動レビューはスキップされました'
		)
	}

	ctx.subscriptions.push(
		reviewCommand,
		toggleAutoReviewCommand,
		toggleAutoReviewOnOpenCommand,
		onSaveSubscription,
		onOpenSubscription,
		// ファイルが閉じられたときにレビューをクリアする
		vscode.workspace.onDidCloseTextDocument((doc) => {
			reviewTreeProvider.clearFileReviews(doc.uri.toString())
		}),
		LLM_REVIEWER_CONSOLE,
		diagnosticCollection
	)

	// コマンドの存在をユーザーに通知
	vscode.window.showInformationMessage(
		'LLMレビューワーが有効になりました。ファイル保存時とオープン時に自動レビューされます。'
	)
}

/**
 * レビュー結果をVSCode診断機能に反映する関数
 * これによりエディタ上に問題がマークされ、「問題」タブにも表示されます
 */
function updateDiagnostics(doc: vscode.TextDocument, reviewText: string): void {
	// 診断結果の配列
	const diagnostics: vscode.Diagnostic[] = []

	// レビューテキストを行ごとに分割して処理
	const lines = reviewText
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

	for (const line of lines) {
		// 重要度と内容を抽出する正規表現
		// 形式: 「[重要度]: 指摘内容」 または 「[重要度]: 指摘内容 [Ln X, Col Y]」
		const severityMatch = line.match(
			/^\[(ERROR|WARNING|INFO|HINT)\]\s*:?\s*(.+?)(?:\s+\[Ln\s+(\d+)(?:,\s*Col\s+(\d+))?\])?$/i
		)

		if (severityMatch) {
			const severityText = severityMatch[1].toUpperCase()
			const content = severityMatch[2].trim()
			// 行番号と列番号を取得（存在する場合）
			const lineNumber = severityMatch[3]
				? parseInt(severityMatch[3], 10) - 1
				: 0
			const colNumber = severityMatch[4]
				? parseInt(severityMatch[4], 10)
				: 0

			// 重要度を判定しVSCodeの診断重要度に変換
			let diagnosticSeverity: vscode.DiagnosticSeverity
			switch (severityText) {
				case 'ERROR':
					diagnosticSeverity = vscode.DiagnosticSeverity.Error
					break
				case 'WARNING':
					diagnosticSeverity = vscode.DiagnosticSeverity.Warning
					break
				case 'INFO':
					diagnosticSeverity = vscode.DiagnosticSeverity.Information
					break
				case 'HINT':
					diagnosticSeverity = vscode.DiagnosticSeverity.Hint
					break
				default:
					diagnosticSeverity = vscode.DiagnosticSeverity.Information
			}

			// 行番号が有効範囲内かチェック
			const safeLineNumber = Math.max(
				0,
				Math.min(lineNumber, doc.lineCount - 1)
			)

			// 行の内容を取得し、範囲を作成
			const line = doc.lineAt(safeLineNumber)
			const range = new vscode.Range(
				safeLineNumber,
				Math.min(colNumber, line.text.length),
				safeLineNumber,
				line.text.length
			)

			// 診断情報を作成
			const diagnostic = new vscode.Diagnostic(
				range,
				content,
				diagnosticSeverity
			)

			// ソースをLLM Reviewerに設定
			diagnostic.source = 'LLM Reviewer'

			// 診断情報を配列に追加
			diagnostics.push(diagnostic)
		}
	}

	// 診断コレクションを更新（以前の診断はすべて削除される）
	diagnosticCollection.set(doc.uri, diagnostics)

	LLM_REVIEWER_CONSOLE.appendLine(
		`[llm-reviewer] ${diagnostics.length} diagnostics added to ${doc.fileName}`
	)
}

async function lintDocument(doc: vscode.TextDocument): Promise<void> {
	const uriString = doc.uri.toString() // URI文字列（TreeViewのキーとして使用）
	const filePath = doc.fileName // 実際のファイルパスを取得

	LLM_REVIEWER_CONSOLE.appendLine(`[llm-reviewer] Start lint → ${filePath}`)

	// アウトプットチャネルを確実に表示
	LLM_REVIEWER_CONSOLE.show(true)

	try {
		// Lint実行前に該当ファイルのレビューをクリア
		reviewTreeProvider.clearFileReviews(uriString)

		// 診断結果もクリア
		diagnosticCollection.delete(doc.uri)

		// ステータスバーに表示
		const statusMessage =
			vscode.window.setStatusBarMessage('LLMによるレビュー実行中...')

		let fullText: string
		try {
			fullText = await requestLLMReviewWithFunctionCalling(
				doc,
				LLM_REVIEWER_CONSOLE
			)
		} catch (llmError) {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] LLMリクエスト中にエラー: ${llmError}`
			)
			vscode.window.showErrorMessage(`LLMリクエストエラー: ${llmError}`)
			statusMessage.dispose()
			return
		}

		// TreeViewを更新
		reviewTreeProvider.update(uriString, fullText)

		// 問題タブへの反映設定を確認
		const showInProblemsTab = vscode.workspace
			.getConfiguration()
			.get<boolean>('llmLint.showInProblemsTab', true)

		// 設定がtrueの場合のみ診断機能（問題タブ）に反映
		if (showInProblemsTab) {
			updateDiagnostics(doc, fullText)
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] レビュー結果を問題タブに反映しました`
			)
		} else {
			LLM_REVIEWER_CONSOLE.appendLine(
				`[llm-reviewer] 設定により問題タブへの反映はスキップされました`
			)
		}

		vscode.window.showInformationMessage(
			`LLMレビューが完了しました: ${filePath}`
		)

		// ステータスバーメッセージをクリア
		statusMessage.dispose()
	} catch (error) {
		LLM_REVIEWER_CONSOLE.appendLine(
			`[llm-reviewer] Error during lint for ${filePath}: ${error}`
		)
		vscode.window.showErrorMessage(`LLM Lint Error: ${error}`)
		// エラーが発生した場合も該当ファイルのレビューをクリア
		reviewTreeProvider.clearFileReviews(uriString)
	}
}
