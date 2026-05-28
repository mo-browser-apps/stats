import { app, BrowserWindow, ipc, Theme } from '@mobrowser/api';
import { native } from './gen/native';
import { Person } from './gen/greet';
import { SetThemeRequest } from './gen/app';
import { GreetServiceDescriptor, AppServiceDescriptor } from './gen/ipc_service';
import * as process from "node:process";

// Create a new window.
const win = new BrowserWindow()
win.browser.loadUrl(app.url)
win.setSize({ width: 800, height: 650 })
win.setWindowTitleVisible(false)
win.setWindowTitlebarVisible(process.platform !== 'darwin')
win.centerWindow()
win.show()

// Handle the IPC calls from the renderer process.
ipc.registerService(GreetServiceDescriptor, {
  async SayHello(person: Person) {
    return await native.greet.SayHello(person)
  }
})

ipc.registerService(AppServiceDescriptor, {
  async SetTheme(request: SetThemeRequest) {
    app.setTheme(request.theme as Theme);
    return {};
  },
})
