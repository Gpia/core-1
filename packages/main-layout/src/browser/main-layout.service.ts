import { Injectable, Autowired, INJECTOR_TOKEN, Injector, Inject, Domain } from '@ali/common-di';
import {
  SplitPanel,
  SplitLayout,
  Widget,
  BoxLayout,
  BoxPanel,
} from '@phosphor/widgets';
import { IdeWidget } from './ide-widget.view';
import { AppConfig, getDomainConstructors, ModuleConstructor } from '@ali/ide-core-browser';
import { SlotLocation } from '../common/main-layout-slot';
import { BottomPanelModule } from '@ali/ide-bottom-panel/lib/browser';
import { ActivatorPanelModule } from '@ali/ide-activator-panel/lib/browser';
import { ActivatorBarModule } from '@ali/ide-activator-bar/lib/browser';
import { Disposable } from '@ali/ide-core-browser';
import { ActivatorBarService } from '@ali/ide-activator-bar/lib/browser/activator-bar.service';
import { BottomPanelService } from '@ali/ide-bottom-panel/lib/browser/bottom-panel.service';
import { SplitPositionHandler } from './split-panels';
import { IEventBus } from '@ali/ide-core-common';
import { InitedEvent, VisibleChangedEvent, VisibleChangedPayload } from '../common';

export interface TabbarWidget {
  widget: Widget;
  panel: Widget;
  size?: number;
}

@Injectable()
export class MainLayoutService extends Disposable {
  @Autowired(INJECTOR_TOKEN)
  injector: Injector;

  @Autowired(IEventBus)
  eventBus: IEventBus;

  @Autowired()
  bottomPanelModule: BottomPanelModule;

  @Autowired()
  activatorPanelModule: ActivatorPanelModule;

  @Autowired()
  activatorBarModule: ActivatorBarModule;

  @Autowired()
  private activityBarService: ActivatorBarService;

  @Autowired()
  private bottomPanelService: BottomPanelService;

  @Autowired()
  splitHandler: SplitPositionHandler;

  static initVerRelativeSizes = [3, 1];
  public verRelativeSizes = [MainLayoutService.initVerRelativeSizes];

  private configContext: AppConfig;

  private topBarWidget: IdeWidget;
  private mainSlotWidget: IdeWidget;
  private bottomBarWidget: IdeWidget;

  private bottomSlotWidget: Widget;
  private leftPanelWidget: Widget;
  private rightPanelWidget: Widget;
  private leftSlotWidget: Widget;

  private horizontalPanel: Widget;
  private middleWidget: SplitPanel;

  private readonly tabbarMap: Map<SlotLocation, TabbarWidget> = new Map();

  // 从上到下包含顶部bar、中间横向大布局和底部bar
  createLayout(node: HTMLElement) {
    this.topBarWidget = this.initIdeWidget(SlotLocation.top);
    this.horizontalPanel = this.createSplitHorizontalPanel();
    this.bottomBarWidget = this.initIdeWidget(SlotLocation.bottom);

    // 设置id，配置样式
    this.topBarWidget.id = 'menu-bar';
    this.horizontalPanel.id = 'main-box';
    this.bottomBarWidget.id = 'status-bar';

    Widget.attach(this.topBarWidget, node);
    Widget.attach(this.horizontalPanel, node);
    Widget.attach(this.bottomBarWidget, node);
  }

  // TODO 后续可以把配置和contribution整合起来
  useConfig(configContext: AppConfig, node: HTMLElement) {
    this.configContext = configContext;
    this.createLayout(node);

    const { layoutConfig } = configContext;
    for (const location of Object.keys(layoutConfig)) {
      if (location === SlotLocation.top) {
        const module = this.getInstanceFrom(layoutConfig[location].modules[0]);
        this.topBarWidget.setComponent(module.component);
      } else if (location === SlotLocation.main) {
        const module = this.getInstanceFrom(layoutConfig[location].modules[0]);
        this.mainSlotWidget.setComponent(module.component);
      } else if (location === SlotLocation.left || location === SlotLocation.bottom) {
        const isSingleMod = layoutConfig[location].modules.length === 1;
        layoutConfig[location].modules.forEach((Module) => {
          const module = this.getInstanceFrom(Module);
          const useTitle = location === SlotLocation.bottom;
          this.registerTabbarComponent(module.component as React.FunctionComponent, useTitle ? module.title : module.iconClass, location, isSingleMod);
        });
      } else if (location === SlotLocation.bottomBar) {
        const module = this.getInstanceFrom(layoutConfig[location].modules[0]);
        this.bottomBarWidget.setComponent(module.component);
      }
    }
  }

  getInstanceFrom(module: Domain | ModuleConstructor) {
    if (typeof module === 'string') {
      return this.injector.get(getDomainConstructors(module)[0]);
    } else {
      return this.injector.get(module);
    }
  }

  toggleSlot(location: SlotLocation, show?: boolean) {
    switch (location) {
      case SlotLocation.bottom:
        this.changeVisibility(this.bottomSlotWidget, location, show);
        break;
      case SlotLocation.left:
      case SlotLocation.right:
        const tabbar = this.getTabbar(location);
        this.changeSideVisibility(tabbar.widget, location, show);
        break;
      default:
        console.warn('未知的SlotLocation!');
    }
    if (show) {
      this.eventBus.fire(new VisibleChangedEvent(new VisibleChangedPayload(true, location)));
    } else {
      this.eventBus.fire(new VisibleChangedEvent(new VisibleChangedPayload(false, location)));
    }
  }

  isVisible(location: SlotLocation) {
    switch (location) {
      case SlotLocation.bottom:
        return this.bottomBarWidget.isVisible;
      case SlotLocation.left:
      case SlotLocation.right:
        const tabbar = this.getTabbar(location);
        return tabbar.panel.isVisible;
      default:
        console.warn('未知的SlotLocation!');
        return false;
    }
  }

  // TODO 运行时模块变化怎么支持？比如左侧的某个Panel拖到底部。底部单个模块兼容
  registerTabbarComponent(component: React.FunctionComponent, extra: string, side: string, isSingleMod: boolean) {
    if (side === SlotLocation.left) {
      if (isSingleMod) {
        (this.leftSlotWidget as IdeWidget).setComponent(component);
      } else {
        this.activityBarService.append({ iconClass: extra, component });
      }
    } else if (side === 'bottom') {
      this.bottomPanelService.append({ title: extra, component });
    }
  }

  private changeVisibility(widget, location: SlotLocation, show?: boolean) {
    if (show === true) {
      this.showWidget(widget, location);
    } else if (show === false) {
      this.hideWidget(widget, location);
    } else {
      widget.isHidden ? this.showWidget(widget, location) : this.hideWidget(widget, location);
    }
  }

  private changeSideVisibility(widget, location: SlotLocation, show?: boolean) {
    if (typeof show === 'boolean') {
      this.togglePanel(location as string, show);
    } else {
      widget.isHidden ? this.togglePanel(location, true) : this.togglePanel(location, false);
    }
  }

  private showWidget(widget: Widget, location: SlotLocation) {
    widget.show();
    if (location === SlotLocation.bottom) {
      this.middleWidget.setRelativeSizes(this.verRelativeSizes.pop() || MainLayoutService.initVerRelativeSizes);
    }
  }

  private hideWidget(widget: Widget, location: SlotLocation) {
    if (location === SlotLocation.bottom) {
      this.verRelativeSizes.push(this.middleWidget.relativeSizes());
    }
    widget.hide();
  }

  private initIdeWidget(location?: string, component?: React.FunctionComponent) {
    return this.injector.get(IdeWidget, [this.configContext, component, location]);
  }

  // TODO 支持不使用Tabbar切换能力
  private createSplitHorizontalPanel() {
    const isLeftSingleMod = this.configContext.layoutConfig.left.modules.length === 1;
    const leftSlotWidget = isLeftSingleMod ? this.initIdeWidget(SlotLocation.left) : this.createActivatorWidget(SlotLocation.left);
    leftSlotWidget.id = 'left-slot';
    if (isLeftSingleMod) {
      leftSlotWidget.node.style.minWidth = '300px';
    }
    this.middleWidget = this.createMiddleWidget();
    const subsidiaryWidget = this.initIdeWidget(SlotLocation.right);
    this.tabbarMap.set(SlotLocation.left, {widget: leftSlotWidget, panel: this.leftPanelWidget});
    this.tabbarMap.set(SlotLocation.right, {widget: subsidiaryWidget, panel: subsidiaryWidget});
    const horizontalSplitLayout = this.createSplitLayout([leftSlotWidget, this.middleWidget, subsidiaryWidget], [0, 1, 0], { orientation: 'horizontal', spacing: 0 });
    const panel = new SplitPanel({ layout: horizontalSplitLayout });
    panel.id = 'main-split';
    // 默认需要调一次展开，将split move移到目标位置
    if (!isLeftSingleMod) {
      this.togglePanel(SlotLocation.left, true);
    }
    this.togglePanel(SlotLocation.right, true);
    return panel;
  }

  private async togglePanel(side: string, show: boolean) {
    const tabbar = this.getTabbar(side);
    const {widget, panel, size} = tabbar;
    const lastPanelSize = size || 300;
    if (show) {
      panel.show();
      widget.removeClass('collapse');
      this.splitHandler.setSidePanelSize(widget, lastPanelSize, { side: side as 'left' | 'right', duration: 100 });
    } else {
      tabbar.size = this.getPanelSize(side);
      widget.addClass('collapse');
      await this.splitHandler.setSidePanelSize(widget, 50, { side: side as 'left' | 'right', duration: 100 });
      panel.hide();
    }
  }

  getPanelSize(side: string) {
    const tabbar = this.getTabbar(side);
    return tabbar.widget.node.clientWidth;
  }

  getTabbar(side: string): TabbarWidget {
    const tabbar = this.tabbarMap.get(side) as TabbarWidget;
    if (!tabbar) {
      console.warn('没有找到这个位置的Tabbar!');
    }
    return tabbar;
  }

  // TODO 在右侧复用
  private createActivatorWidget(side: string) {
    const activatorBarWidget = this.initIdeWidget(undefined, this.activatorBarModule.component);
    activatorBarWidget.id = 'activator-bar';
    const activatorPanelWidget = this.initIdeWidget(SlotLocation.left, this.activatorPanelModule.component);
    if (side === SlotLocation.left) {
      this.leftPanelWidget = activatorPanelWidget;
    } else {
      this.rightPanelWidget = activatorPanelWidget;
    }
    const containerLayout = new BoxLayout({ direction: side === SlotLocation.left ? 'left-to-right' : 'right-to-left', spacing: 0 });
    BoxPanel.setStretch(activatorBarWidget, 0);
    containerLayout.addWidget(activatorBarWidget);
    BoxPanel.setStretch(activatorPanelWidget, 1);
    containerLayout.addWidget(activatorPanelWidget);

    const activitorWidget = new BoxPanel({ layout: containerLayout });
    return activitorWidget;
  }

  /**
   * Create a split layout to assemble the application shell layout.
   */
  protected createSplitLayout(widgets: Widget[], stretch?: number[], options?: Partial<SplitLayout.IOptions>): SplitLayout {
    let optParam: SplitLayout.IOptions = { renderer: SplitPanel.defaultRenderer };
    if (options) {
      optParam = { ...optParam, ...options };
    }
    const splitLayout = new SplitLayout(optParam);
    for (let i = 0; i < widgets.length; i++) {
      if (stretch !== undefined && i < stretch.length) {
        SplitPanel.setStretch(widgets[i], stretch[i]);
      }
      splitLayout.addWidget(widgets[i]);
    }
    return splitLayout;
  }

  private createMiddleWidget() {
    const middleWidget = new SplitPanel({ orientation: 'vertical', spacing: 0 });
    this.mainSlotWidget = this.initIdeWidget(SlotLocation.main);
    this.bottomSlotWidget = this.initIdeWidget(SlotLocation.bottom, this.bottomPanelModule.component);
    middleWidget.addWidget(this.mainSlotWidget);
    middleWidget.addWidget(this.bottomSlotWidget);
    middleWidget.setRelativeSizes(this.verRelativeSizes.pop() || MainLayoutService.initVerRelativeSizes);
    return middleWidget;
  }

  updateResizeWidget() {
    this.horizontalPanel.update();
    this.middleWidget.update();
  }

  initedLayout() {
    this.eventBus.fire(new InitedEvent());
  }

  destroy() {
    Widget.detach(this.topBarWidget);
    Widget.detach(this.horizontalPanel);
    Widget.detach(this.bottomBarWidget);
  }
}
