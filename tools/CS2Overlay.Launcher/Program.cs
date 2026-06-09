using System.Diagnostics;

var baseDir = AppContext.BaseDirectory;
var nodePath = Path.Combine(baseDir, "runtime", "node.exe");
var appDir = Path.Combine(baseDir, "app");
var serverPath = Path.Combine(appDir, "server.js");

if (!File.Exists(nodePath))
{
    Fail($"Missing runtime: {nodePath}");
    return 1;
}

if (!File.Exists(serverPath))
{
    Fail($"Missing app entrypoint: {serverPath}");
    return 1;
}

var startInfo = new ProcessStartInfo
{
    FileName = nodePath,
    WorkingDirectory = appDir,
    UseShellExecute = false,
};

startInfo.ArgumentList.Add(serverPath);
foreach (var arg in args)
{
    startInfo.ArgumentList.Add(arg);
}

if (!startInfo.Environment.ContainsKey("PLAYWRIGHT_CHANNEL"))
{
    startInfo.Environment["PLAYWRIGHT_CHANNEL"] = "msedge";
}

Console.WriteLine("Starting CS2 Overlay...");
Console.WriteLine("Overlay URL: http://localhost:3000/");
Console.WriteLine();

using var child = Process.Start(startInfo);
if (child is null)
{
    Fail("Could not start the bundled Node.js runtime.");
    return 1;
}

child.WaitForExit();
return child.ExitCode;

static void Fail(string message)
{
    Console.Error.WriteLine($"CS2Overlay launcher error: {message}");
    Console.Error.WriteLine("This release folder may be incomplete. Rebuild it with scripts/build-portable.ps1.");
}
