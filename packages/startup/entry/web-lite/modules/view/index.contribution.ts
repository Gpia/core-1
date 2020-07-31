import { Injectable } from '@ali/common-di';
import { Domain } from '@ali/ide-core-common';
import { SlotRendererContribution, SlotRendererRegistry, SlotLocation } from '@ali/ide-core-browser';
import { RightTabRenderer } from './custom-tabbar-renderer';

@Injectable()
@Domain(SlotRendererContribution)
export class ViewContribution implements SlotRendererContribution {
  registerRenderer(registry: SlotRendererRegistry) {
    registry.registerSlotRenderer(SlotLocation.right, RightTabRenderer);
  }

}
