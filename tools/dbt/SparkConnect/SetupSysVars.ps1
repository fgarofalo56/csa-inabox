# https://sparkbyexamples.com/spark/apache-spark-installation-on-windows/

# Post Java and Apache Spark installation on Windows, set: environment variables
    # JAVA_HOME
    # SPARK_HOME
    # HADOOP_HOME
    # PATH

# Set environment variables
$JAVA_HOME = "C:\Program Files\Java\jdk-1.8"
$SPARK_HOME = "S:\DevResources\tools\spark-3.5.0-bin-hadoop3"
$HADOOP_HOME = "S:\DevResources\tools\spark-3.5.0-bin-hadoop3"
$addPath = ";%JAVA_HOME%\bin;%SPARK_HOME%\bin;%HADOOP_HOME%\bin"


# Add new environment variables for JAVA_HOME, SPARK_HOME, HADOOP_HOME
New-Item -Path Env: -Name "JAVA_HOME" -Value $JAVA_HOME
New-Item -Path Env: -Name "SPARK_HOME" -Value $SPARK_HOME
New-Item -Path Env: -Name "HADOOP_HOME" -Value $HADOOP_HOME

#Update PATH environment variable
$env:PATH += $addPath


# View current environment variables
Get-ChildItem Env:

# View current PATH environment variable into parm and split into a list
$envPath = $env:PATH
$envPathList = $envPath.Split(";")
$envPathList

