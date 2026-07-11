export const getAllFilesRecursive = async (event: DragEvent) => {
//https://qiita.com/KokiSakano/items/a122bc0a1a368c697643
event.preventDefault();

// filesの初期化
const files: File[] = [];

// 最上階層から再起的に低い階層へファイルを取得するまで呼び出す
const searchFile = async (entry: any) => {
    // ファイルのwebkitRelativePathにパスを登録する
    if (entry.isFile) {
    const file:File = await new Promise((resolve) => {
        entry.file((file:any) => {
        resolve(file);
        });
    });
    files.push(file);
    // ファイルが現れるまでこちらの分岐をループし続ける
    } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    let allEntries: any[] = [];
    const getEntries = () =>
        new Promise((resolve) => {
        dirReader.readEntries((entries:any) => {
            resolve(entries);
        });
        });
    // readEntriesは100件ずつの取得なので、再帰で0件になるまで取ってくるようにする
    // https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryReader/readEntries
    const readAllEntries = async () => {
        const entries = await getEntries();
        if ((entries as any).length > 0) {
        allEntries = allEntries.concat(entries);
        await readAllEntries();
        }
    };
    await readAllEntries();
    for (const entry of allEntries) {
        await searchFile(entry);
    }
    }
};

const items = event.dataTransfer!.items;
const calcFullPathPerItems = Array.from(items).map((item) => {
    return new Promise((resolve) => {
    const entry = item.webkitGetAsEntry();
    // nullの時は何もしない
    if (!entry) {
        resolve;
        return;
    }
    resolve(searchFile(entry));
    });
});

await Promise.all(calcFullPathPerItems);
// handleFiles(files);

return files;
};
