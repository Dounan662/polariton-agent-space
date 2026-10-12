#import <Cocoa/Cocoa.h>

// A native UI helper, not a domain service. Only a selected local directory is
// returned; cancellation is an ordinary null result and no source files are read.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    [panel setCanChooseFiles:NO];
    [panel setCanChooseDirectories:YES];
    [panel setAllowsMultipleSelection:NO];
    [panel setCanCreateDirectories:YES];
    [panel setTitle:@"Choose a folder"];
    [panel setPrompt:@"Choose folder"];
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
      puts("{\"ready\":true}");
      return 0;
    }
    [app finishLaunching];
    [app activateIgnoringOtherApps:YES];
    NSModalResponse response = [panel runModal];
    id path = response == NSModalResponseOK ? [[panel URL] path] : [NSNull null];
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"path":path} options:0 error:&error];
    if (!json) {fputs([[error localizedDescription] UTF8String], stderr); return 1;}
    fwrite([json bytes], 1, [json length], stdout);
    fputc('\n', stdout);
    return 0;
  }
}
