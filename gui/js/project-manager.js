/**
 * 项目管理器模块
 * 负责项目的 新建 / 保存 / 另存为 / 打开 操作
 */
window.ProjectManager = {
    async save() {
        const data   = Storage.collectCanvasData();
        const result = await API.saveProject(data);
        if (result.status === 'need_save_as') {
            this.saveAs();
        } else if (result.status === 'success') {
            this.updateTitle(result.path);
            HistorySidebar.clear();
            Toast.show('保存成功');
        } else {
            Toast.show('保存失败: ' + result.message);
        }
    },

    async saveAs() {
        const data   = Storage.collectCanvasData();
        const result = await API.saveProjectAs(data);
        if (result.status === 'success') {
            this.updateTitle(result.path);
            HistorySidebar.clear();
            Toast.show('保存成功');
        } else if (result.status !== 'cancelled') {
            Toast.show('保存失败: ' + result.message);
        }
    },

    async open() {
        const result = await API.openProject();
        if (result.status === 'success') {
            Storage.restoreCanvasData(result.data);
            this.updateTitle(result.path);
            Toast.show('项目已打开');
        } else if (result.status !== 'cancelled') {
            Toast.show('打开失败: ' + result.message);
        }
    },

    new() {
        if (!confirm('确定要新建项目吗？未保存的更改将丢失。')) return;
        Storage.restoreCanvasData({ cards: [], connections: [], canvas: {}, projectName: '未命名项目' });
        const input = document.getElementById('project-name-input');
        if (input) input.value = '未命名项目';
        Toast.show('新建项目');
    },

    updateTitle(path) {
        const input = document.getElementById('project-name-input');
        if (!input) return;
        if (path) {
            const name = path.split(/[/\\]/).pop();
            input.value = name ? name.replace(/\.icproj$/, '') : '未命名项目';
        } else {
            input.value = '未命名项目';
        }
    }
};
