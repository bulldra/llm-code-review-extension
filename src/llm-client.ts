import * as vscode from 'vscode'

function cfg<T>(key: string): T {
	return vscode.workspace.getConfiguration().get<T>(`llmLint.${key}`)!
}

export const LLM_CONFIG = {
	MODEL: cfg<string>('model'),
	PORT: cfg<number>('port'),
	THREADS: cfg<number>('threads'),
}

interface FunctionCallResponse {
	id: string
	object: string
	created: number
	model: string
	choices: Array<{
		index: number
		message: {
			role: string
			content: string | null
			function_call?: {
				name: string
				arguments: string
			}
			tool_calls?: Array<{
				id: string
				type: string
				function: {
					name: string
					arguments: string
				}
			}>
		}
		finish_reason: string
	}>
}

interface ReviewItem {
	severity: 'ERROR' | 'WARNING' | 'INFO' | 'HINT'
	message: string
	codeSnippet?: string
}

const reviewFunctions = [
	{
		type: 'function',
		function: {
			description: 'ソースコードのレビューを行い、問題点を指摘します',
			name: 'reviewCode',
			parameters: {
				type: 'object',
				properties: {
					reviews: {
						type: 'array',
						description: 'レビュー結果の配列',
						items: {
							type: 'object',
							properties: {
								severity: {
									type: 'string',
									enum: ['ERROR', 'WARNING', 'INFO', 'HINT'],
									description:
										'問題の重要度（ERROR:実行時エラーや深刻なバグ、WARNING:パフォーマンス問題や潜在バグ、INFO:コード品質や可読性、HINT:スタイルや命名規則）',
								},
								message: {
									type: 'string',
									description:
										'問題の内容説明（日本語で簡潔に記述）',
								},
								codeSnippet: {
									type: 'string',
									description:
										'問題のある該当コードの断片。行番号は不要で、最小限の判別可能なコードブロックを記載。変数名や関数名など特徴的な部分を含めること',
								},
							},
							required: ['severity', 'message'],
						},
					},
				},
			},
			required: ['reviews'],
		},
	},
]

export async function requestLLMReviewWithFunctionCalling(
	doc: vscode.TextDocument,
	OUTPUT: vscode.OutputChannel
): Promise<string> {
	const prompt = [
		'/no_think',
		'```',
		doc.getText(),
		'```',
		'上記のソースコードをレビューし、問題点を診断してください。',
		'重要度は次の4つのいずれかから選択してください: [ERROR], [WARNING], [INFO], [HINT]',
		'- [ERROR]: 実行時エラーや深刻なバグ、セキュリティの脆弱性など',
		'- [WARNING]: ベストプラクティス違反、パフォーマンスの問題、潜在的なバグなど',
		'- [INFO]: コードの品質や可読性に関する提案',
		'- [HINT]: スタイル、命名、コメント、ドキュメントなどに関する提案や改善点',
		'指摘は直接的で簡潔な日本語で、コードの改善点を具体的に示してください。',
		'同じ問題の繰り返しは避け、各問題は一度だけ報告してください。',
		`ファイルパス: ${doc.fileName}`,
		`言語: ${doc.languageId}`,
		'コードの長さ: ' + doc.lineCount + '行',
		'',
		'重要：位置情報（行番号や列番号）を指定しないでください。代わりに、問題のある箇所を特定できるコードスニペットを提供してください。',
		'コードスニペットには最小限の必要なコンテキスト（変数名、関数名、特徴的な式など）を含めてください。',
	].join('\n')

	const body = {
		model: LLM_CONFIG.MODEL,
		temperature: 0,
		cpuThreads: LLM_CONFIG.THREADS,
		stream: false,
		messages: [{ role: 'user', content: prompt }],
		tools: reviewFunctions,
		tool_choice: 'auto',
	}

	OUTPUT.appendLine(
		`[llm-reviewer] Function Callingモードでリクエスト実行中...`
	)

	try {
		const res = await fetch(
			`http://localhost:${LLM_CONFIG.PORT}/v1/chat/completions`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}
		)

		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${await res.text()}`)
		}

		const data = (await res.json()) as FunctionCallResponse

		try {
			const toolCalls = data.choices?.[0]?.message?.tool_calls
			if (toolCalls && toolCalls.length > 0) {
				for (const toolCall of toolCalls) {
					if (toolCall.function?.name === 'reviewCode') {
						const functionCallResult = JSON.parse(
							toolCall.function.arguments
						)
						const formattedReviews = formatFunctionCallResults(
							functionCallResult,
							doc,
							OUTPUT
						)

						OUTPUT.appendLine(`[llm-reviewer] Tool Calls結果:`)
						OUTPUT.appendLine(functionCallResult)

						return formattedReviews
					}
				}
			}
		} catch (error) {
			OUTPUT.appendLine(
				`[llm-reviewer] Function Calling実行エラー: ${error}`
			)
		}
	} catch (error) {
		OUTPUT.appendLine(`[llm-reviewer] Function Calling実行エラー: ${error}`)
	}
	return 'レビュー結果がありません'
}

/**
 * LLMからのレビュー結果を解析して、コード内の位置を特定し、フォーマットする
 */
function formatFunctionCallResults(
	result: { reviews: ReviewItem[] },
	doc: vscode.TextDocument,
	OUTPUT: vscode.OutputChannel
): string {
	if (!result.reviews || !Array.isArray(result.reviews)) {
		return 'レビュー結果がありません'
	}
	const formattedLines = result.reviews.map((review) => {
		// コードスニペットがある場合、そのスニペットの位置をドキュメント内で検索
		let position = findPositionByCodeSnippet(
			review.codeSnippet,
			doc,
			OUTPUT
		)
		let locationText = ''

		if (position) {
			locationText = ` [Ln ${position.line + 1}, Col ${
				position.character
			}]`
		}

		return `[${review.severity}]${review.message}${locationText}`
	})

	return formattedLines.join('\n')
}

/**
 * コードスニペットに基づいて、ドキュメント内での位置を検索する
 */
function findPositionByCodeSnippet(
	snippet: string | undefined,
	doc: vscode.TextDocument,
	OUTPUT: vscode.OutputChannel
): vscode.Position | null {
	if (!snippet) {
		return null
	}

	// スニペットの正規表現エスケープ
	const escapedSnippet = snippet
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.trim()
		.replace(/\s+/g, '\\s+') // 空白文字の柔軟なマッチングを許可

	try {
		const regex = new RegExp(escapedSnippet, 'g')
		const docText = doc.getText()

		const match = regex.exec(docText)
		if (match) {
			const offset = match.index
			return doc.positionAt(offset)
		}
	} catch (e) {
		// 正規表現エラーを無視
		console.error('Regex error:', e)
	}

	// より高度なマッチングを試みる（部分文字列での検索）
	if (snippet.length > 15) {
		// 十分な長さのスニペットの場合のみ
		const docText = doc.getText()
		const words = snippet
			.split(/\s+/)
			.filter((word) => word.length > 3) // 短すぎる単語は除外
			.slice(0, 3) // 最初の3つの有意な単語を使用

		for (const word of words) {
			const index = docText.indexOf(word)
			if (index >= 0) {
				// 見つかった単語の周辺のコンテキストをチェック
				const contextStart = Math.max(0, index - 50)
				const contextEnd = Math.min(docText.length, index + 50)
				const context = docText.substring(contextStart, contextEnd)

				// このコンテキスト内でスニペットの一部がさらにマッチするかチェック
				if (words.filter((w) => context.includes(w)).length >= 2) {
					return doc.positionAt(index)
				}
			}
		}
	}

	return null
}
