/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import * as ts from './lgService';
import { LGWorker } from './tsWorker';

import Uri = monaco.Uri;
import Position = monaco.Position;
import Range = monaco.Range;
import Thenable = monaco.Thenable;
import CancellationToken = monaco.CancellationToken;
import IDisposable = monaco.IDisposable;

//#region utils copied from typescript to prevent loading the entire typescriptServices ---

enum IndentStyle {
	None = 0,
	Block = 1,
	Smart = 2
}

function flattenDiagnosticMessageText(messageText: string | ts.DiagnosticMessageChain, newLine: '\n'): string {
	if (typeof messageText === "string") {
		return messageText;
	} else {
		let diagnosticChain = messageText;
		let result = "";
		let indent = 0;
		while (diagnosticChain) {
			if (indent) {
				result += newLine;
				for (let i = 0; i < indent; i++) {
					result += "  ";
				}
			}
			result += diagnosticChain.messageText;
			indent++;
			diagnosticChain = diagnosticChain.next;
		}
		return result;
	}
}

function displayPartsToString(displayParts: ts.SymbolDisplayPart[]): string {
	if (displayParts) {
		return displayParts.map((displayPart) => displayPart.text).join("");
	}
	return "";
}

//#endregion

export abstract class Adapter {

	constructor(protected _worker: (first: Uri, ...more: Uri[]) => Promise<LGWorker>) {
	}

	protected _positionToOffset(uri: Uri, position: monaco.IPosition): number {
		let model = monaco.editor.getModel(uri);
		return model.getOffsetAt(position);
	}

	protected _offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
		let model = monaco.editor.getModel(uri);
		return model.getPositionAt(offset);
	}

	protected _textSpanToRange(uri: Uri, span: ts.TextSpan): monaco.IRange {
		let p1 = this._offsetToPosition(uri, span.start);
		let p2 = this._offsetToPosition(uri, span.start + span.length);
		let { lineNumber: startLineNumber, column: startColumn } = p1;
		let { lineNumber: endLineNumber, column: endColumn } = p2;
		return { startLineNumber, startColumn, endLineNumber, endColumn };
	}
}

// --- diagnostics --- ---

export class DiagnostcsAdapter extends Adapter {

	private _disposables: IDisposable[] = [];
	private _listener: { [uri: string]: IDisposable } = Object.create(null);

	constructor(private _defaults: LanguageServiceDefaultsImpl, private _selector: string,
		worker: (first: Uri, ...more: Uri[]) => Promise<LGWorker>
	) {
		super(worker);

		const onModelAdd = (model: monaco.editor.IModel): void => {
			if (model.getModeId() !== _selector) {
				return;
			}

			let handle: number;
			const changeSubscription = model.onDidChangeContent(() => {
				clearTimeout(handle);
				handle = setTimeout(() => this._doValidate(model.uri, model.getLinesContent().join('\n')), 500);
			});

			this._listener[model.uri.toString()] = {
				dispose() {
					changeSubscription.dispose();
					clearTimeout(handle);
				}
			};

			this._doValidate(model.uri, model.getLinesContent().join('\n'));

		};

		const onModelRemoved = (model: monaco.editor.IModel): void => {
			monaco.editor.setModelMarkers(model, this._selector, []);
			const key = model.uri.toString();
			if (this._listener[key]) {
				this._listener[key].dispose();
				delete this._listener[key];
			}
		};

		this._disposables.push(monaco.editor.onDidCreateModel(onModelAdd));
		this._disposables.push(monaco.editor.onWillDisposeModel(onModelRemoved));
		this._disposables.push(monaco.editor.onDidChangeModelLanguage(event => {
			onModelRemoved(event.model);
			onModelAdd(event.model);
		}));

		this._disposables.push({
			dispose() {
				for (const model of monaco.editor.getModels()) {
					onModelRemoved(model);
				}
			}
		});

		const recomputeDiagostics = () => {
			// redo diagnostics when options change
			for (const model of monaco.editor.getModels()) {
				onModelRemoved(model);
				onModelAdd(model);
			}
		};
		this._disposables.push(this._defaults.onDidChange(recomputeDiagostics));
		monaco.editor.getModels().forEach(onModelAdd);
	}

	public dispose(): void {
		this._disposables.forEach(d => d && d.dispose());
		this._disposables = [];
	}

	private _doValidate(resource: Uri, contents: string): void {
		this._worker(resource).then(worker => {
			if (!monaco.editor.getModel(resource)) {
				// model was disposed in the meantime
				return null;
			}
			const promises: Promise<ts.Diagnostic[]>[] = [];
			promises.push(worker.getLGDiagnostics(contents));
			return Promise.all(promises);
		}).then(diagnostics => {
			if (!diagnostics || !monaco.editor.getModel(resource)) {
				// model was disposed in the meantime
				return null;
			}
			const markers = diagnostics
				.reduce((p, c) => c.concat(p), [])
				.map(d => this._convertDiagnostics(resource, d));
			monaco.editor.setModelMarkers(monaco.editor.getModel(resource), this._selector, markers);
		}).then(undefined, err => {
		});
	}

	private toSeverity(lsSeverity: number): monaco.MarkerSeverity {
		switch (lsSeverity) {
			case ts.DiagnosticCategory.Error: return monaco.MarkerSeverity.Error;
			case ts.DiagnosticCategory.Warning: return monaco.MarkerSeverity.Warning;
			case ts.DiagnosticCategory.Message: return monaco.MarkerSeverity.Info;
			case ts.DiagnosticCategory.Suggestion: return monaco.MarkerSeverity.Hint;
			default:
				return monaco.MarkerSeverity.Info;
		}
	}

	private _convertDiagnostics(resource: Uri, diag: ts.Diagnostic): monaco.editor.IMarkerData {
		const { lineNumber: startLineNumber, column: startColumn } =  { lineNumber: diag.start, column: diag.startColumn }
		const { lineNumber: endLineNumber, column: endColumn } = { lineNumber: diag.end, column: diag.endColumn }

		return {
			severity: this.toSeverity(diag.category),
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn,
			message: flattenDiagnosticMessageText(diag.messageText, '\n')
		};
	}
}

// --- suggest ------

interface MyCompletionItem extends monaco.languages.CompletionItem {
	uri: Uri;
	position: Position;
}

export class SuggestAdapter extends Adapter implements monaco.languages.CompletionItemProvider {

	public get triggerCharacters(): string[] {
		return ['.'];
	}

	provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: Position, _context: monaco.languages.CompletionContext, token: CancellationToken): Thenable<monaco.languages.CompletionList> {
		const wordInfo = model.getWordUntilPosition(position);
		const wordRange = new Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn);
		const resource = model.uri;
		const offset = this._positionToOffset(resource, position);

		return this._worker(resource).then(() => {
			let suggestions: monaco.languages.CompletionItem[] = [{
				label: 'ifelse',
				kind: monaco.languages.CompletionItemKind.Snippet,
				range: wordRange,
				insertText: [
					'if (${1:condition}) {',
					'\t$0',
					'} else {',
					'\t',
					'}'
				].join('\n'),
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'If-Else Statement'
			},
			{
				label: 'template',
				kind: monaco.languages.CompletionItemKind.Snippet,
				range: wordRange,
				insertText: [
					"# ${1:template_name}(${2:optional_parameters})",
					"- hi"
				].join('\n'),
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'New Template'
			},
			{
				label: 'import',
				kind: monaco.languages.CompletionItemKind.Snippet,
				range: wordRange,
				insertText: [
					"[import](${1:relative path of extra lg file})"
				].join('\n'),
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'New import'
			},
			{
				label: 'switchcase',
				kind: monaco.languages.CompletionItemKind.Snippet,
				range: wordRange,
				insertText: [
					"SWITCH:{${1:case}}",
						  "- CASE: {${2:case1}}",
						  "    - ${3:output1}",
						  "- CASE: {${4:case2}}",
						  "    - ${5:output2}",
						  "- DEFAULT:",
						  "   - ${6:final output}"
				].join('\n'),
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Switch case Statement'
			},
			{
				label: 'add',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'add(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the result from adding two numbers.'
			},
			{
				label: 'div',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'div(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the integer result from dividing two numbers.'
			},
			{
				label: 'mod',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'mod(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the remainder from dividing two numbers.'
			},
			{
				label: 'mul',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'mul(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the product from multiplying two numbers.'
			},
			{
				label: 'sub',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'sub(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the result from subtracting the second number from the first number.'
			},
			{
				label: 'exp',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'exp(${1:number}, ${2:number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return the result from subtracting the second number from the first number.'
			},
			{
				label: 'concat',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'concat(${1: string[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Combine two or more strings and return the resulting string. E.g. concat(‘hello’, ‘world’, ‘…’)'
			},
			{
				label: 'not',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'not(${1: expression})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether an expression is false. Return true when the expression is false, or return false when true.'
			},
			{
				label: 'and',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'and(${1: any[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether all expressions are true. Return true when all expressions are true, or return false when at least one expression is false.'
			},
			{
				label: 'or',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'or(${1: any[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether at least one expression is true. Return true when at least one expression is true, or return false when all are false.'
			},
			{
				label: 'equals',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'equals(${1: any}, ${2: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Comparison equal. Returns true if specified values are equal'
			},
			{
				label: 'greater',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'greater(${1: any}, ${2: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether the first value is greater than the second value. Return true when the first value is more, or return false when less.'
			},
			{
				label: 'greaterOrEquals',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'greaterOrEquals(${1: any}, ${2: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether the first value is greater than or equal to the second value. Return true when the first value is greater or equal, or return false when the first value is less.'
			},
			{
				label: 'less',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'less(${1: any}, ${2: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether the first value is less than the second value. Return true when the first value is less, or return false when the first value is more.'
			},
			{
				label: 'lessOrEquals',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'lessOrEquals(${1: any}, ${2: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check whether the first value is less than or equal to the second value. Return true when the first value is less than or equal, or return false when the first value is more.'
			},
			{
				label: 'join',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'join(${1: Array}, ${2: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return a string that has all the items from an array and has each character separated by a delimiter.'
			},
			{
				label: 'first',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'first(${1: Array|string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Returns the first item from the collection'
			},
			{
				label: 'last',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'last(${1: Array|string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Returns the last item from the collection'
			},
			{
				label: 'foreach',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'foreach(${1: Array}, ${2: string}, ${3: function})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Operate on each element and return the new collection'
			},
			{
				label: 'empty',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'empty(${1: Array})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Check if the collection is empty'
			},
			{
				label: 'newGuid',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'newGuid()',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation: 'Return new guid string'
			},
			{
				label: 'min',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'min(${1: number[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns the smallest value from a collection'
			},
			{
				label: 'max',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'max(${1: number[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns the largest value from a collection'
			},
			{
				label: 'average',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'average(${1: number[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns the average value from a collection'
			},
			{
				label: 'sum',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'sum(${1: number[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Return the result from adding numbers in a list.'
			},
			{
				label: 'exists',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'exists(${1: expression})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Evaluates an expression for truthiness.'
			},
			{
				label: 'length',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'length(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns the length of a string.'
			},
			{
				label: 'replace',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'replace(${1: string},${2: string}, ${3: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Replace a substring with the specified string, and return the updated string. case sensitive'
			},
			{
				label: 'replaceIgnoreCase',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'replaceIgnoreCase(${1: string},${2: string}, ${3: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Replace a substring with the specified string, and return the updated string. case in-sensitive'
			},
			{
				label: 'split',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'split(${1: string},${2: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns an array that contains substrings based on the delimiter specified.'
			},
			{
				label: 'substring',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'substring(${1: string},${2: number}, ${3: number})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns characters from a string. Substring(sourceString, startPos, endPos). startPos cannot be less than 0. endPos greater than source strings length will be taken as the max length of the string'
			},
			{
				label: 'toLower',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'toLower(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Convert a string to all lower case characters'
			},
			{
				label: 'toUpper',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'toUpper(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Convert a string to all upper case characters'
			},
			{
				label: 'trim',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'trim(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Remove leading and trailing white spaces from a string'
			},
			{
				label: 'count',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'count(${1: string|Array})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Returns the number of items in the collection'
			},
			{
				label: 'contains',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'contains(${1: string|Array|Map}, ${2: stirng|object})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Works to find an item in a string or to find an item in an array or to find a parameter in a complex object. E.g. contains(‘hello world, ‘hello); contains([‘1’, ‘2’], ‘1’); contains({“foo”:”bar”}, “foo”)'
			},
			{
				label: 'float',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'float(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Return floating point representation of the specified string or the string itself if conversion is not possible'
			},
			{
				label: 'int',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'int(${1: string})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Return integer representation of the specified string or the string itself if conversion is not possible.'
			},
			{
				label: 'string',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'string(${1: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Return string version of the specified value.'
			},
			{
				label: 'bool',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'bool(${1: any})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Return Boolean representation of the specified object. Bool(‘true’), bool(1)'
			},
			{
				label: 'createArray',
				kind: monaco.languages.CompletionItemKind.Function,
				range: wordRange,
				insertText: 'createArray(${1: any[]})',
				insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
				documentation:  'Create an array from multiple inputs'
			},
		]
			//let suggestions: MyCompletionItem[] = info.entries.map(entry => {
			// 	let range = wordRange;
			// 	if (entry.replacementSpan) {
			// 		const p1 = model.getPositionAt(entry.replacementSpan.start);
			// 		const p2 = model.getPositionAt(entry.replacementSpan.start + entry.replacementSpan.length);
			// 		range = new Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column);
			// 	}

			// 	return {
			// 		uri: resource,
			// 		position: position,
			// 		range: range,
			// 		label: entry.name,
			// 		insertText: entry.name,
			// 		sortText: entry.sortText,
			// 		kind: SuggestAdapter.convertKind(entry.kind)
			// 	};
			// });

			return {
				suggestions
			};
		});
	}
}

// export class SignatureHelpAdapter extends Adapter implements monaco.languages.SignatureHelpProvider {

// 	public signatureHelpTriggerCharacters = ['(', ','];

// 	provideSignatureHelp(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.SignatureHelp> {
// 		let resource = model.uri;
// 		return this._worker(resource).then(worker => worker.getSignatureHelpItems(resource.toString(), this._positionToOffset(resource, position))).then(info => {

// 			if (!info) {
// 				return;
// 			}

// 			let ret: monaco.languages.SignatureHelp = {
// 				activeSignature: info.selectedItemIndex,
// 				activeParameter: info.argumentIndex,
// 				signatures: []
// 			};

// 			info.items.forEach(item => {

// 				let signature: monaco.languages.SignatureInformation = {
// 					label: '',
// 					documentation: null,
// 					parameters: []
// 				};

// 				signature.label += displayPartsToString(item.prefixDisplayParts);
// 				item.parameters.forEach((p, i, a) => {
// 					let label = displayPartsToString(p.displayParts);
// 					let parameter: monaco.languages.ParameterInformation = {
// 						label: label,
// 						documentation: displayPartsToString(p.documentation)
// 					};
// 					signature.label += label;
// 					signature.parameters.push(parameter);
// 					if (i < a.length - 1) {
// 						signature.label += displayPartsToString(item.separatorDisplayParts);
// 					}
// 				});
// 				signature.label += displayPartsToString(item.suffixDisplayParts);
// 				ret.signatures.push(signature);
// 			});

// 			return ret;

// 		});
// 	}
// }

// // --- hover ------

// export class QuickInfoAdapter extends Adapter implements monaco.languages.HoverProvider {

// 	provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
// 		let resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getQuickInfoAtPosition(resource.toString(), this._positionToOffset(resource, position));
// 		}).then(info => {
// 			if (!info) {
// 				return;
// 			}
// 			let documentation = displayPartsToString(info.documentation);
// 			let tags = info.tags ? info.tags.map(tag => {
// 				const label = `*@${tag.name}*`;
// 				if (!tag.text) {
// 					return label;
// 				}
// 				return label + (tag.text.match(/\r\n|\n/g) ? ' \n' + tag.text : ` - ${tag.text}`);
// 			})
// 				.join('  \n\n') : '';
// 			let contents = displayPartsToString(info.displayParts);
// 			return {
// 				range: this._textSpanToRange(resource, info.textSpan),
// 				contents: [{
// 					value: '```js\n' + contents + '\n```\n'
// 				}, {
// 					value: documentation + (tags ? '\n\n' + tags : '')
// 				}]
// 			};
// 		});
// 	}
// }

// // --- occurrences ------

// export class OccurrencesAdapter extends Adapter implements monaco.languages.DocumentHighlightProvider {

// 	public provideDocumentHighlights(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.DocumentHighlight[]> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getOccurrencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
// 		}).then(entries => {
// 			if (!entries) {
// 				return;
// 			}
// 			return entries.map(entry => {
// 				return <monaco.languages.DocumentHighlight>{
// 					range: this._textSpanToRange(resource, entry.textSpan),
// 					kind: entry.isWriteAccess ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text
// 				};
// 			});
// 		});
// 	}
// }

// // --- definition ------

// export class DefinitionAdapter extends Adapter {

// 	public provideDefinition(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Definition> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getDefinitionAtPosition(resource.toString(), this._positionToOffset(resource, position));
// 		}).then(entries => {
// 			if (!entries) {
// 				return;
// 			}
// 			const result: monaco.languages.Location[] = [];
// 			for (let entry of entries) {
// 				const uri = Uri.parse(entry.fileName);
// 				if (monaco.editor.getModel(uri)) {
// 					result.push({
// 						uri: uri,
// 						range: this._textSpanToRange(uri, entry.textSpan)
// 					});
// 				}
// 			}
// 			return result;
// 		});
// 	}
// }

// // --- references ------

// export class ReferenceAdapter extends Adapter implements monaco.languages.ReferenceProvider {

// 	provideReferences(model: monaco.editor.IReadOnlyModel, position: Position, context: monaco.languages.ReferenceContext, token: CancellationToken): Thenable<monaco.languages.Location[]> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getReferencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
// 		}).then(entries => {
// 			if (!entries) {
// 				return;
// 			}
// 			const result: monaco.languages.Location[] = [];
// 			for (let entry of entries) {
// 				const uri = Uri.parse(entry.fileName);
// 				if (monaco.editor.getModel(uri)) {
// 					result.push({
// 						uri: uri,
// 						range: this._textSpanToRange(uri, entry.textSpan)
// 					});
// 				}
// 			}
// 			return result;
// 		});
// 	}
// }

// // --- outline ------

// export class OutlineAdapter extends Adapter implements monaco.languages.DocumentSymbolProvider {

// 	public provideDocumentSymbols(model: monaco.editor.IReadOnlyModel, token: CancellationToken): Thenable<monaco.languages.DocumentSymbol[]> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => worker.getNavigationBarItems(resource.toString())).then(items => {
// 			if (!items) {
// 				return;
// 			}

// 			const convert = (bucket: monaco.languages.DocumentSymbol[], item: ts.NavigationBarItem, containerLabel?: string): void => {
// 				let result: monaco.languages.DocumentSymbol = {
// 					name: item.text,
// 					detail: '',
// 					kind: <monaco.languages.SymbolKind>(outlineTypeTable[item.kind] || monaco.languages.SymbolKind.Variable),
// 					range: this._textSpanToRange(resource, item.spans[0]),
// 					selectionRange: this._textSpanToRange(resource, item.spans[0]),
// 					containerName: containerLabel
// 				};

// 				if (item.childItems && item.childItems.length > 0) {
// 					for (let child of item.childItems) {
// 						convert(bucket, child, result.name);
// 					}
// 				}

// 				bucket.push(result);
// 			}

// 			let result: monaco.languages.DocumentSymbol[] = [];
// 			items.forEach(item => convert(result, item));
// 			return result;
// 		});
// 	}
// }

// export class Kind {
// 	public static unknown: string = '';
// 	public static keyword: string = 'keyword';
// 	public static script: string = 'script';
// 	public static module: string = 'module';
// 	public static class: string = 'class';
// 	public static interface: string = 'interface';
// 	public static type: string = 'type';
// 	public static enum: string = 'enum';
// 	public static variable: string = 'var';
// 	public static localVariable: string = 'local var';
// 	public static function: string = 'function';
// 	public static localFunction: string = 'local function';
// 	public static memberFunction: string = 'method';
// 	public static memberGetAccessor: string = 'getter';
// 	public static memberSetAccessor: string = 'setter';
// 	public static memberVariable: string = 'property';
// 	public static constructorImplementation: string = 'constructor';
// 	public static callSignature: string = 'call';
// 	public static indexSignature: string = 'index';
// 	public static constructSignature: string = 'construct';
// 	public static parameter: string = 'parameter';
// 	public static typeParameter: string = 'type parameter';
// 	public static primitiveType: string = 'primitive type';
// 	public static label: string = 'label';
// 	public static alias: string = 'alias';
// 	public static const: string = 'const';
// 	public static let: string = 'let';
// 	public static warning: string = 'warning';
// }

// let outlineTypeTable: { [kind: string]: monaco.languages.SymbolKind } = Object.create(null);
// outlineTypeTable[Kind.module] = monaco.languages.SymbolKind.Module;
// outlineTypeTable[Kind.class] = monaco.languages.SymbolKind.Class;
// outlineTypeTable[Kind.enum] = monaco.languages.SymbolKind.Enum;
// outlineTypeTable[Kind.interface] = monaco.languages.SymbolKind.Interface;
// outlineTypeTable[Kind.memberFunction] = monaco.languages.SymbolKind.Method;
// outlineTypeTable[Kind.memberVariable] = monaco.languages.SymbolKind.Property;
// outlineTypeTable[Kind.memberGetAccessor] = monaco.languages.SymbolKind.Property;
// outlineTypeTable[Kind.memberSetAccessor] = monaco.languages.SymbolKind.Property;
// outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
// outlineTypeTable[Kind.const] = monaco.languages.SymbolKind.Variable;
// outlineTypeTable[Kind.localVariable] = monaco.languages.SymbolKind.Variable;
// outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
// outlineTypeTable[Kind.function] = monaco.languages.SymbolKind.Function;
// outlineTypeTable[Kind.localFunction] = monaco.languages.SymbolKind.Function;

// // --- formatting ----

// export abstract class FormatHelper extends Adapter {
// 	protected static _convertOptions(options: monaco.languages.FormattingOptions): ts.FormatCodeOptions {
// 		return {
// 			ConvertTabsToSpaces: options.insertSpaces,
// 			TabSize: options.tabSize,
// 			IndentSize: options.tabSize,
// 			IndentStyle: IndentStyle.Smart,
// 			NewLineCharacter: '\n',
// 			InsertSpaceAfterCommaDelimiter: true,
// 			InsertSpaceAfterSemicolonInForStatements: true,
// 			InsertSpaceBeforeAndAfterBinaryOperators: true,
// 			InsertSpaceAfterKeywordsInControlFlowStatements: true,
// 			InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
// 			InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
// 			InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
// 			InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
// 			PlaceOpenBraceOnNewLineForControlBlocks: false,
// 			PlaceOpenBraceOnNewLineForFunctions: false
// 		};
// 	}

// 	protected _convertTextChanges(uri: Uri, change: ts.TextChange): monaco.editor.ISingleEditOperation {
// 		return <monaco.editor.ISingleEditOperation>{
// 			text: change.newText,
// 			range: this._textSpanToRange(uri, change.span)
// 		};
// 	}
// }

// export class FormatAdapter extends FormatHelper implements monaco.languages.DocumentRangeFormattingEditProvider {

// 	provideDocumentRangeFormattingEdits(model: monaco.editor.IReadOnlyModel, range: Range, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getFormattingEditsForRange(resource.toString(),
// 				this._positionToOffset(resource, { lineNumber: range.startLineNumber, column: range.startColumn }),
// 				this._positionToOffset(resource, { lineNumber: range.endLineNumber, column: range.endColumn }),
// 				FormatHelper._convertOptions(options));
// 		}).then(edits => {
// 			if (edits) {
// 				return edits.map(edit => this._convertTextChanges(resource, edit));
// 			}
// 		});
// 	}
// }

// export class FormatOnTypeAdapter extends FormatHelper implements monaco.languages.OnTypeFormattingEditProvider {

// 	get autoFormatTriggerCharacters() {
// 		return [';', '}', '\n'];
// 	}

// 	provideOnTypeFormattingEdits(model: monaco.editor.IReadOnlyModel, position: Position, ch: string, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
// 		const resource = model.uri;

// 		return this._worker(resource).then(worker => {
// 			return worker.getFormattingEditsAfterKeystroke(resource.toString(),
// 				this._positionToOffset(resource, position),
// 				ch, FormatHelper._convertOptions(options));
// 		}).then(edits => {
// 			if (edits) {
// 				return edits.map(edit => this._convertTextChanges(resource, edit));
// 			}
// 		});
// 	}
//}