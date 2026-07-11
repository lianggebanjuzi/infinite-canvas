// src/bridge.ts
// 将所有模块桥接到 window，解决 declare const 全局变量引用问题
// 必须在所有其他模块之前加载

import { API } from './utils/api';
import { Dom } from './utils/dom';
import { uid } from './utils/uid';
import { LazyLoader } from './utils/lazy-loader';
import { SnapshotUtils } from './utils/snapshot';

import { AppState } from './state/app-state';

import { Toast } from './ui/toast';

import { Canvas } from './core/canvas';
import { CmdManager } from './core/command-manager';
import { Clipboard } from './core/clipboard';
import { Storage } from './core/storage';

import { BaseCard } from './cards/base-card';
import { TextCard } from './cards/text-card';
import { ImageInputCard } from './cards/image-input-card';
import { AIDrawCard } from './cards/ai-draw-card';
import { DrawingBoardCard } from './cards/drawing-board-card';
import { PreviewCard } from './cards/preview-card';
import { AgentCard } from './cards/agent-card';
import { CompareCard } from './cards/compare-card';
import { CardFactory } from './cards/card-factory';
import { CardEventBus } from './cards/card-event-bus';
import { CardContract } from './cards/card-contract';
import { ConnectionRules } from './cards/connection-rules';
import { DataSource } from './cards/data-source';
import { PipelineEngine } from './cards/pipeline-engine';

import { SettingsPanel } from './components/settings';
import { ProviderPanel } from './components/provider-panel';
import { ModelPanel } from './components/model-panel';
import { ConnectionManager } from './components/connection';
import { Minimap } from './components/minimap';
import { HistorySidebar } from './components/history-sidebar';

import { ThemeManager } from './independent/theme-manager';
import { ImageModal } from './independent/image-modal';
import { ProjectManager } from './independent/project-manager';
import { SelectionBox } from './independent/selection-box';
import { Laser as LaserCutter } from './independent/laser-cutter';
import { AgentPanel } from './independent/agent-panel';

import { GroupManager } from './groups/GroupManager';
import { GroupRenderer } from './groups/GroupRenderer';
import { GroupExecutor } from './groups/GroupExecutor';
import { GroupActions } from './groups/group-actions';

import {
    PropertyChangeCommand,
    ModifyContentCommand,
    MoveCardsCommand,
    CreateCardCommand,
    DeleteCardsCommand,
    CreateConnectionCommand,
    RemoveConnectionCommand,
    CreateGroupCommand,
    DeleteGroupCommand,
    GroupPropertyCommand,
    ProjectNameCommand,
} from './core/commands';

import { PromptService } from './services/prompt-service';

const w = window as unknown as Record<string, unknown>;

// Utils
w.API = API;
w.Dom = Dom;
w.uid = uid;
w.LazyLoader = LazyLoader;
w.SnapshotUtils = SnapshotUtils;

// State
w.AppState = AppState;

// UI
w.Toast = Toast;

// Core
w.Canvas = Canvas;
w.CmdManager = CmdManager;
w.Clipboard = Clipboard;
w.Storage = Storage;

// Commands
w.PropertyChangeCommand = PropertyChangeCommand;
w.ModifyContentCommand = ModifyContentCommand;
w.MoveCardsCommand = MoveCardsCommand;
w.CreateCardCommand = CreateCardCommand;
w.DeleteCardsCommand = DeleteCardsCommand;
w.CreateConnectionCommand = CreateConnectionCommand;
w.RemoveConnectionCommand = RemoveConnectionCommand;
w.CreateGroupCommand = CreateGroupCommand;
w.DeleteGroupCommand = DeleteGroupCommand;
w.GroupPropertyCommand = GroupPropertyCommand;
w.ProjectNameCommand = ProjectNameCommand;

// Cards
w.BaseCard = BaseCard;
w.TextCard = TextCard;
w.ImageInputCard = ImageInputCard;
w.AIDrawCard = AIDrawCard;
w.DrawingBoardCard = DrawingBoardCard;
w.PreviewCard = PreviewCard;
w.AgentCard = AgentCard;
w.CompareCard = CompareCard;
w.CardFactory = CardFactory;
w.CardEventBus = CardEventBus;
w.CardContract = CardContract;
w.ConnectionRules = ConnectionRules;
w.DataSource = DataSource;
w.PipelineEngine = PipelineEngine;

// Components
w.SettingsPanel = SettingsPanel;
w.ProviderPanel = ProviderPanel;
w.ModelPanel = ModelPanel;
w.ConnectionManager = ConnectionManager;
w.Minimap = Minimap;
w.HistorySidebar = HistorySidebar;

// Independent
w.ThemeManager = ThemeManager;
w.ImageModal = ImageModal;
w.ProjectManager = ProjectManager;
w.SelectionBox = SelectionBox;
w.Laser = LaserCutter;
w.AgentPanel = AgentPanel;

// Groups
w.GroupManager = GroupManager;
w.GroupRenderer = GroupRenderer;
w.GroupExecutor = GroupExecutor;
w.GroupActions = GroupActions;

// Services
w.PromptService = PromptService;
