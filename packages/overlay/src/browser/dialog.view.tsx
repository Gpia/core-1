import { observer } from 'mobx-react-lite';
import React from 'react';

import { Button, Dialog as DialogView } from '@opensumi/ide-components';
import { localize, strings, useInjectable } from '@opensumi/ide-core-browser';

import { IDialogService } from '../common';

export const Dialog = observer(() => {
  const dialogService = useInjectable<IDialogService>(IDialogService);
  const icon = dialogService.getIcon();
  const message = dialogService.getMessage();
  const buttons = dialogService.getButtons();
  const type = dialogService.getType();
  // props will transfer to Overlay component
  const customProps = dialogService.getProps();

  function afterClose() {
    dialogService.reset();
  }

  function handleClose() {
    dialogService.hide();
  }

  function handlerClickButton(value: string) {
    return () => {
      dialogService.hide(value);
    };
  }

  return (
    <DialogView
      visible={dialogService.isVisible()}
      onClose={handleClose}
      closable={dialogService.closable}
      afterClose={afterClose}
      message={message}
      type='confirm'
      messageType={type}
      icon={icon}
      keyboard={true}
      buttons={
        buttons.length ? (
          buttons.map((button, index) => (
            <Button
              size='large'
              onClick={handlerClickButton(button)}
              key={button}
              type={index === buttons.length - 1 ? 'primary' : 'secondary'}
            >
              {strings.mnemonicButtonLabel(button, true)}
            </Button>
          ))
        ) : (
          <Button size='large' onClick={handleClose} type='primary'>
            {localize('dialog.confirm')}
          </Button>
        )
      }
      {...customProps}
    />
  );
});
