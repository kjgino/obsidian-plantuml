import PlantumlPlugin from "../main";
import {Processor} from "./processor";
import {MarkdownPostProcessorContext, moment} from "obsidian";
import * as plantuml from "plantuml-encoder";
import {insertAsciiImage, insertImageWithMap, insertSvgImage} from "../functions";
import {OutputType} from "../const";
import * as localforage from "localforage";

export class LocalProcessors implements Processor {

    plugin: PlantumlPlugin;

    constructor(plugin: PlantumlPlugin) {
        this.plugin = plugin;
    }

    ascii = async(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const encodedDiagram = plantuml.encode(source);
        const item: string = await localforage.getItem('ascii-' + encodedDiagram);
        if(item) {
            insertAsciiImage(el, item);
            await localforage.setItem('ts-' + encodedDiagram, Date.now());
            return;
        }

        const image = await this.generateLocalImage(source, OutputType.ASCII, this.plugin.replacer.getPath(ctx));
        insertAsciiImage(el, image);
        await localforage.setItem('ascii-' + encodedDiagram, image);
        await localforage.setItem('ts-' + encodedDiagram, Date.now());
    }

    png = async(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const encodedDiagram = plantuml.encode(source);
        const item: string = await localforage.getItem('png-' + encodedDiagram);
        if(item) {
            const map: string = await localforage.getItem('map-' + encodedDiagram);
            insertImageWithMap(el, item , map, encodedDiagram);
            await localforage.setItem('ts-' + encodedDiagram, Date.now());
            return;
        }

        const path = this.plugin.replacer.getPath(ctx);
        const image = await this.generateLocalImage(source, OutputType.PNG, path);
        const map = await this.generateLocalMap(source, path);

        await localforage.setItem('png-' + encodedDiagram, image);
        await localforage.setItem('map-' + encodedDiagram, map);
        await localforage.setItem('ts-'+ encodedDiagram, Date.now());

        insertImageWithMap(el, image, map, encodedDiagram);
    }

    svg = async(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const encodedDiagram = plantuml.encode(source);
        const item: string = await localforage.getItem('svg-' + encodedDiagram);
        if(item) {
            insertSvgImage(el, item);
            await localforage.setItem('ts-' + encodedDiagram, Date.now());
            return;
        }
        const image = await this.generateLocalImage(source, OutputType.SVG, this.plugin.replacer.getPath(ctx));
        await localforage.setItem('svg-' + encodedDiagram, image);
        await localforage.setItem('ts-' + encodedDiagram, Date.now());
        insertSvgImage(el, image);
    }

    async generateLocalMap(source: string, path: string): Promise<string> {
        // exec()ではなくspawn()を使用することで、Windows環境での引用符の問題を回避
        // spawn()は引数を配列として受け取るため、パスにスペースが含まれていても正しく処理される
        const {spawn} = require('child_process');
        const args = this.resolveLocalJarCmd().concat(['-pipemap']);
        const [command, ...commandArgs] = args;
        const child = spawn(command, commandArgs, {cwd: path});

        let stdout = "";
        let stderr = "";

        if (child.stdout) {
            child.stdout.on("data", (data: Buffer) => {
                stdout += data.toString('binary');
            });
        }

        if (child.stderr) {
            child.stderr.on('data', (data: Buffer) => {
                stderr += data.toString('utf-8');
            });
        }

        return new Promise((resolve, reject) => {
            child.on("error", (error: Error) => {
                // プロセス起動時のエラー（Javaが見つからない、JARファイルが存在しないなど）
                console.error("PlantUML map generation error:", error);
                reject(error);
            });

            child.on("close", (code: any) => {
                if (code === 0) {
                    // 正常終了：画像マップデータを返す
                    resolve(stdout);
                    return;
                } else {
                    // エラー終了：stderr、stdout、またはデフォルトメッセージを使用
                    const errorMsg = stderr || stdout || `PlantUML map generation exited with code ${code}`;
                    console.error("PlantUML map generation error (code " + code + "):", errorMsg);
                    reject(new Error(errorMsg));
                }
            });

            child.stdin.write(source, 'utf-8');
            child.stdin.end();
        });
    }

    async generateLocalImage(source: string, type: OutputType, path: string): Promise<string> {
        // exec()ではなくspawn()を使用することで、Windows環境での引用符の問題を回避
        // spawn()は引数を配列として受け取るため、パスにスペースが含まれていても正しく処理される
        // これにより、-graphvizdotオプションのパスが正しく認識される
        const {spawn} = require('child_process');
        const args = this.resolveLocalJarCmd().concat(['-t' + type, '-pipe']);
        const [command, ...commandArgs] = args;
        const child = spawn(command, commandArgs, {cwd: path});

        let stdoutChunks: Buffer[] = [];
        let stderr: string = "";

        if (child.stdout) {
            child.stdout.on("data", (data: Buffer) => {
                stdoutChunks.push(data);
            });
        }

        if (child.stderr) {
            child.stderr.on('data', (data: Buffer) => {
                stderr += data.toString('utf-8');
            });
        }

        return new Promise((resolve, reject) => {
            child.on("error", (error: Error) => {
                console.error("PlantUML execution error:", error);
                reject(error);
            });

            child.on("close", (code: any) => {
                // spawn()は複数のBufferチャンクを返す可能性があるため、結合する必要がある
                let combined: Buffer;
                if (stdoutChunks.length === 0) {
                    combined = Buffer.alloc(0);
                } else if (stdoutChunks.length === 1) {
                    combined = stdoutChunks[0];
                } else {
                    // 複数のチャンクを1つのBufferに結合
                    const totalLength = stdoutChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                    combined = Buffer.allocUnsafe(totalLength);
                    let offset = 0;
                    for (const chunk of stdoutChunks) {
                        // @ts-ignore - Buffer.copy()は正しく動作するが、型定義に問題がある
                        chunk.copy(combined, offset);
                        offset += chunk.length;
                    }
                }

                if (code === 0) {
                    // 正常終了の場合
                    if (combined.length === 0) {
                        // 出力がない場合はエラー（Graphvizが見つからない場合など）
                        const errorMsg = stderr || "No output from PlantUML";
                        console.error("PlantUML error:", errorMsg);
                        reject(new Error(errorMsg));
                        return;
                    }
                    if (type === OutputType.PNG) {
                        // PNGはバイナリデータなのでbase64エンコード
                        resolve(combined.toString('base64'));
                        return;
                    }
                    // SVG, ASCIIなどのテキスト形式はUTF-8でデコード
                    resolve(combined.toString('utf-8'));
                    return;
                } else {
                    // エラーコードが0以外の場合（エラー終了）
                    // stderrにエラーメッセージが含まれている可能性が高い
                    const errorMsg = stderr || `PlantUML exited with code ${code}`;
                    console.error("PlantUML error (code " + code + "):", errorMsg);
                    // PNGの場合、エラーでも部分的に画像データが生成されている可能性がある
                    // その場合は画像を返す（エラーメッセージが画像に含まれる場合もある）
                    if (combined.length > 0 && type === OutputType.PNG) {
                        resolve(combined.toString('base64'));
                        return;
                    }
                    reject(new Error(errorMsg));
                    return;
                }
            });
            child.stdin.write(source, "utf-8");
            child.stdin.end();
        });
    }

    /**
     * To support local jar settings with unix-like style, and search local jar file
     * from current vault path.
     */
    private resolveLocalJarCmd(): string[] {
        const jarFromSettings = this.plugin.settings.localJar;
        const {isAbsolute, resolve} = require('path');
        const {userInfo} = require('os');
        let jarFullPath: string;
        const path = this.plugin.replacer.getFullPath("");

        if (jarFromSettings[0] === '~') {
            // As a workaround, I'm not sure what would isAbsolute() return with unix-like path
            jarFullPath = userInfo().homedir + jarFromSettings.slice(1);
        }
        else {
            if (isAbsolute(jarFromSettings)) {
                jarFullPath = jarFromSettings;
            }
            else {
                // the default search path is current vault
                jarFullPath = resolve(path, jarFromSettings);
            }
        }

        if (jarFullPath.length == 0) {
            throw Error('Invalid local jar file');
        }

        // spawn()を使うため、引用符は不要（引数は配列として渡される）
        const dotPath = this.plugin.settings.dotPath;
        const plantumlArgs = [
            '-charset', 
            'utf-8'
        ];
        
        // -graphvizdotオプションの条件付き追加
        // PlantUMLはGraphvizのdotコマンドを自動検出できるため、明示的な指定は必須ではない
        // 以下の場合のみ、-graphvizdotオプションを追加する：
        // 1. dotPathが設定されている
        // 2. 空文字列でない
        // 3. デフォルト値('dot')でない（システムパスにdotがある場合は自動検出に任せる）
        // 
        // これにより、Graphvizがシステムパスにある環境では自動検出が使用され、
        // カスタムパスが必要な環境では明示的に指定できる
        if (dotPath && dotPath.trim() !== '' && dotPath !== 'dot') {
            plantumlArgs.push('-graphvizdot', dotPath);
        }

        if(jarFullPath.endsWith('.jar')) {
            // JVMオプション（-Djava.awt.headless=true）は-jarの前に配置する必要がある
            // これはJavaのコマンドライン引数の仕様による
            return [
                this.plugin.settings.javaPath, 
                '-Djava.awt.headless=true',  // JVMオプション：GUIなしで実行
                '-jar', 
                jarFullPath,
                ...plantumlArgs  // PlantUMLのオプション
            ];
        }
        // jarファイルでない場合（直接実行可能な場合）
        return [
            jarFullPath, 
            '-Djava.awt.headless=true',
            ...plantumlArgs
        ];
    }
}
